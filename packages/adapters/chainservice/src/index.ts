import { providers, Signer, constants } from 'ethers';
import { ChainService as ChimeraChainService, WriteTransaction } from '@chimera-monorepo/chainservice';
import { ILogger } from '@mark/logger';
import { createLoggingContext, ChainConfiguration, TransactionRequest } from '@mark/core';
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
      addresses[chain] = await this.txService.getAddress(+chain);
    }
    return addresses;
  }

  async submitAndMonitor(chainId: string, transaction: TransactionRequest): Promise<providers.TransactionReceipt> {
    const { requestContext } = createLoggingContext('submitAndMonitor');
    const context = { ...requestContext, origin: 'chainservice' };

    if (!this.config.chains[chainId]) {
      throw new Error(`Chain ${chainId} not supported`);
    }

    const writeTransaction: WriteTransaction = {
      to: transaction.to!,
      data: transaction.data! as `0x${string}`,
      value: transaction.value ? transaction.value.toString() : '0',
      domain: parseInt(chainId),
      from: transaction.from ?? undefined,
      // TODO: fill this for tron support
      funcSig: '',
    };
    try {
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
        error,
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
