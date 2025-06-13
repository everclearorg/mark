import { providers, Signer, constants } from 'ethers';
import {
  ChainService as ChimeraChainService,
  ITransactionReceipt,
  WriteTransaction,
} from '@chimera-monorepo/chainservice';
import { ILogger } from '@mark/logger';
import { createLoggingContext, ChainConfiguration, TransactionRequest, WalletConfig } from '@mark/core';
import SafeApiKit from '@safe-global/api-kit';
import Safe from '@safe-global/protocol-kit';
import { MetaTransactionData, OperationType } from '@safe-global/types-kit';

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

  async proposeMultisigTransaction(
    chainId: string,
    request: TransactionRequest,
    walletConfig: WalletConfig,
  ): Promise<string> {
    if (!walletConfig.safeAddress) {
      throw new Error(`No safe address found in wallet configuration.`);
    }
    // Initialize the Protocol Kit with Owner A
    const protocolKitOwnerA = await Safe.init({
      provider: this.config.chains[chainId].providers[0],
      safeAddress: walletConfig.safeAddress,
    });

    // Create a Safe transaction
    const safeTransactionData: MetaTransactionData = {
      to: request.to!,
      value: request.value || '0',
      data: request.data || '0x',
      operation: OperationType.Call,
    };

    const safeTransaction = await protocolKitOwnerA.createTransaction({
      transactions: [safeTransactionData],
    });

    const safeTxHash = await protocolKitOwnerA.getTransactionHash(safeTransaction);
    const signature = await this.signer.signMessage(safeTxHash);

    // Initialize the API Kit
    const apiKit = new SafeApiKit({
      chainId: BigInt(chainId),
      txServiceUrl: this.config.chains[chainId].safeTxService,
    });

    // Send the transaction to the Transaction Service with the signature from Owner A
    await apiKit.proposeTransaction({
      safeAddress: walletConfig.safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress: await this.signer.getAddress(),
      senderSignature: signature,
    });

    return safeTxHash;
  }

  async getSafeTransactionReceipt(chainId: string, safeHash: string): Promise<undefined | ITransactionReceipt> {
    // Initialize the API Kit
    const apiKit = new SafeApiKit({
      chainId: BigInt(chainId),
      txServiceUrl: this.config.chains[chainId].safeTxService,
    });

    const safeTransaction = await apiKit.getTransaction(safeHash);
    if (!safeTransaction || !safeTransaction.isExecuted) {
      return undefined;
    }

    if (!safeTransaction.transactionHash) {
      throw new Error(`Safe transaction is executed without transaction hash!`);
    }

    const receipt = await this.txService.getTransactionReceipt(+chainId, safeTransaction.transactionHash!);
    return receipt;
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
}
