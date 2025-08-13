import { providers, Signer, constants, BigNumber } from 'ethers';
import { TronWeb } from 'tronweb';
import { ChainService as ChimeraChainService, WriteTransaction } from '@chimera-monorepo/chainservice';
import { ILogger, jsonifyError } from '@mark/logger';
import {
  createLoggingContext,
  ChainConfiguration,
  TransactionRequest,
  isTvmChain,
  prependHexPrefix,
  delay,
  TRON_CHAINID,
} from '@mark/core';
import { Address, getAddressEncoder, getProgramDerivedAddress, isAddress } from '@solana/addresses';

export { EthWallet } from '@chimera-monorepo/chainservice';
export interface ChainServiceConfig {
  chains: Record<string, ChainConfiguration>;
  maxRetries?: number;
  retryDelay?: number;
  logLevel?: string;
}

export class ChainService {
  private readonly txService: ChimeraChainService;
  private readonly logger: ILogger;
  private readonly config: ChainServiceConfig;
  private readonly signer: Signer;

  constructor(config: ChainServiceConfig, signer: Signer, logger: ILogger) {
    this.config = config;
    this.logger = logger;
    this.signer = signer;

    // Convert chain configuration format to nxtp-txservice format
    const nxtpChainConfig = Object.entries(config.chains).reduce(
      (acc, [chainId, chainConfig]) => ({
        ...acc,
        [chainId]: {
          providers: chainConfig.providers.map((url) => url),
          confirmations: 2,
          confirmationTimeout: config.retryDelay || 45000,
          // NOTE: enable per chain pk overrides
          privateKey: chainConfig.privateKey,
        },
      }),
      {},
    );

    this.txService = new ChimeraChainService(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any,
      nxtpChainConfig,
      signer,
      true,
    );

    this.logger.info('Chain service initialized', {
      supportedChains: Object.keys(config.chains),
    });
  }

  async getAddress() {
    const addresses: { [chain: string]: string } = {};
    for (const chain in this.config.chains) {
      addresses[chain] = isTvmChain(chain)
        ? (this.getTronClient().defaultAddress.base58 as string)
        : await this.txService.getAddress(+chain);
    }
    return addresses;
  }

  private getTronClient() {
    // Create tronweb client
    const [url] = this.config.chains[TRON_CHAINID].providers;
    // NOTE: this works for trongrid, but may not for other providers
    const [host, key] = url.split('?apiKey=');
    const tronWeb = new TronWeb({
      fullHost: host,
      privateKey: this.config.chains[TRON_CHAINID].privateKey,
      headers: {
        'TRON-PRO-API-KEY': key,
      },
    });
    return tronWeb;
  }

  async submitAndMonitor(chainId: string, transaction: TransactionRequest): Promise<providers.TransactionReceipt> {
    const { requestContext } = createLoggingContext('submitAndMonitor');
    const context = { ...requestContext, origin: 'chainservice' };

    if (!this.config.chains[chainId] || !this.config.chains[chainId].providers.length) {
      throw new Error(`Chain ${chainId} not supported / no providers found`);
    }

    const writeTransaction: WriteTransaction = {
      to: transaction.to!,
      data: transaction.data! as `0x${string}`,
      value: transaction.value ? transaction.value.toString() : '0',
      domain: parseInt(chainId),
      from: transaction.from ?? undefined,
      funcSig: transaction.funcSig,
    };

    try {
      if (isTvmChain(chainId)) {
        // TODO: Fix the chainservice -- even when transactions are successful they register as
        // reverting.

        // Create tronweb client
        const tronWeb = this.getTronClient();

        if (writeTransaction.data.length === 0 || writeTransaction.data === '0x') {
          throw new Error(`Fix native asset transfer handling and use txservice methods`);
        }

        const tx = await tronWeb.transactionBuilder.triggerSmartContract(
          writeTransaction.to,
          writeTransaction.funcSig,
          {
            feeLimit: 1000000000,
            callValue: +writeTransaction.value,
            rawParameter: writeTransaction.data.startsWith('0x')
              ? writeTransaction.data.slice(2)
              : writeTransaction.data,
          },
          [], // Empty parameters array since we're using rawParameter
          tronWeb.defaultAddress.hex as string,
        );
        this.logger.info('Tron transaction submitted', { chainId, transaction: tx });
        if (!tx.result || !tx.result.result) {
          throw new Error(`Failed to create tron transaction: ${JSON.stringify(tx)}`);
        }
        const signedTransaction = await tronWeb.trx.signTransaction(tx.transaction);
        this.logger.debug('Tron transaction signed', { signedTransaction, chainId });
        const broadcast = await tronWeb.trx.sendRawTransaction(signedTransaction);
        this.logger.debug('Tron transaction broadcast', { broadcast, chainId });
        let info = await tronWeb.trx.getTransactionInfo(broadcast.txid);
        let start = Date.now();
        let exists = info && Object.keys(info).length > 0;
        const maxWait = 2 * 60 * 1000; // 2min
        while (!exists && Date.now() - start < maxWait) {
          await delay(250);
          info = await tronWeb.trx.getTransactionInfo(broadcast.txid);
          exists = info && Object.keys(info).length > 0;
        }
        if (!info || Object.keys(info).length === 0) {
          throw new Error(`Failed to get tron transaction info for ${broadcast.txid}`);
        }
        if (info.receipt.result !== 'SUCCESS') {
          throw new Error(`Tron transaction failed onchain ${broadcast.txid}: ${info.receipt.result}`);
        }

        const logs = await tronWeb.event.getEventsByTransactionID(broadcast.txid);
        if (logs.error) {
          throw new Error(`Failed to get tron transaction events: ${logs.error}`);
        }
        this.logger.debug('Tron transaction info', { info, chainId });
        return {
          to: writeTransaction.to.toLowerCase(),
          transactionHash: broadcast.txid.toLowerCase(),
          from: tronWeb.defaultAddress.hex as string,
          logs: info.log.map((l) => ({
            contract: prependHexPrefix(l.address).toLowerCase(),
            data: prependHexPrefix(l.data).toLowerCase(),
            topics: l.topics.map((t) => prependHexPrefix(t).toLowerCase()),
          })),
          cumulativeGasUsed: BigNumber.from(info.receipt.energy_usage_total),
          effectiveGasPrice: BigNumber.from(info.receipt.energy_fee),
        } as unknown as providers.TransactionReceipt;
      }

      // TODO: once mark supports solana, need a new way to track gas here / update the type of receipt.
      const tx = (await this.txService.sendTx(writeTransaction, context)) as unknown as providers.TransactionReceipt;

      this.logger.info('Transaction mined', {
        chainId,
        txHash: tx.transactionHash,
      });

      return tx;
    } catch (error) {
      this.logger.error('Failed to submit transaction', {
        chainId,
        error: jsonifyError(error),
      });
      throw error;
    }
  }

  getTransactionReceipt(chain: number, transactionHash: string) {
    return this.txService.getTransactionReceipt(chain, transactionHash);
  }

  getProvider(chain: number) {
    return this.txService.getProvider(chain);
  }

  getBalance(chain: number, owner: string, asset: string) {
    return this.txService.getBalance(chain, owner, asset === constants.AddressZero ? undefined : asset);
  }

  async readTx(transaction: { to: string; data: string; domain: number; funcSig: string }, blockTag?: string) {
    return this.txService.readTx(transaction, blockTag || 'latest');
  }

  isAssetSupported(chainId: string, assetAddress: string): boolean {
    const chainConfig = this.config.chains[chainId];
    if (!chainConfig) return false;

    return chainConfig.assets.some((asset) => asset.address.toLowerCase() === assetAddress.toLowerCase());
  }

  getAssetConfig(chainId: string, assetAddress: string) {
    const chainConfig = this.config.chains[chainId];
    if (!chainConfig) return undefined;

    return chainConfig.assets.find((asset) => asset.address.toLowerCase() === assetAddress.toLowerCase());
  }

  deriveProgramAddress(programId: string, seeds: string[]) {
    const addressEncoder = getAddressEncoder();
    return getProgramDerivedAddress({
      programAddress: programId as Address,
      seeds: seeds.map((seed) => {
        if (isAddress(seed)) {
          return addressEncoder.encode(seed as Address);
        }
        return new Uint8Array(Buffer.from(seed));
      }),
    });
  }
}
