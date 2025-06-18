import { providers, Signer, constants } from 'ethers';
import * as ethers from 'ethers';
import {
  ChainService as ChimeraChainService,
  ITransactionReceipt,
  WriteTransaction,
} from '@chimera-monorepo/chainservice';
import { ILogger, jsonifyError } from '@mark/logger';
import {
  createLoggingContext,
  ChainConfiguration,
  TransactionRequest,
  WalletConfig,
  axiosPost,
  axiosGet,
} from '@mark/core';
import SafeApiKit from '@safe-global/api-kit';
import Safe, { EthersAdapter } from '@safe-global/protocol-kit';
import { MetaTransactionData, OperationType, SafeMultisigTransactionResponse } from '@safe-global/types-kit';

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
    // Create eth adapter
    const provider = new providers.FallbackProvider(
      this.config.chains[chainId].providers.map((p) => new providers.JsonRpcProvider(p)),
      1,
    );
    const ethAdapter = new EthersAdapter({ signerOrProvider: this.signer.connect(provider), ethers });

    // Initialize the Protocol Kit with Owner A
    const protocolKitOwnerA = await Safe.create({
      ethAdapter,
      safeAddress: walletConfig.safeAddress,
    });

    const { apiKit, txServiceUrl } = this.getSafeApiKit(chainId);

    // Create a Safe transaction
    const safeTransactionData: MetaTransactionData = {
      to: request.to!,
      value: request.value || '0',
      data: request.data || '0x',
      operation: OperationType.Call,
    };

    // Get all pending transactions
    const nonce = await this.getNextMultisigTransactionNonce(chainId, protocolKitOwnerA);

    const safeTransaction = await protocolKitOwnerA.createTransaction({
      safeTransactionData: [safeTransactionData],
      options: nonce ? { nonce } : undefined,
    });

    const senderAddress = await this.signer.getAddress();
    const safeTxHash = await protocolKitOwnerA.getTransactionHash(safeTransaction);
    const sdkSignature = await protocolKitOwnerA.signTransactionHash(safeTxHash);

    // Send the transaction to the Transaction Service with the signature from Owner A
    try {
      await apiKit.proposeTransaction({
        safeAddress: walletConfig.safeAddress,
        safeTransactionData: safeTransaction.data,
        safeTxHash,
        senderAddress,
        senderSignature: sdkSignature.data,
      });
    } catch (e) {
      const body = {
        safe: walletConfig.safeAddress,
        to: safeTransaction.data.to,
        value: safeTransaction.data.value,
        data: safeTransaction.data.data,
        operation: safeTransaction.data.operation,
        gasToken: safeTransaction.data.gasToken,
        safeTxGas: safeTransaction.data.safeTxGas,
        baseGas: safeTransaction.data.baseGas,
        gasPrice: safeTransaction.data.gasPrice,
        refundReceiver: safeTransaction.data.refundReceiver,
        nonce: safeTransaction.data.nonce,
        contractTransactionHash: safeTxHash,
        signature: sdkSignature.data,
        sender: senderAddress,
      };
      this.logger.warn('Failed to send transaction with Safe API Kit, trying axios with v2 url', {
        error: jsonifyError(e),
        txServiceUrl,
        body,
      });

      const v2url = `${txServiceUrl}/api/v2/safes/${walletConfig.safeAddress}/multisig-transactions/`;

      try {
        await axiosPost(v2url, body, undefined, 1, 100);
        console.log();
        return safeTxHash;
      } catch (err) {
        this.logger.error('Failed to send using v2', {
          error: jsonifyError(err),
          url: v2url,
          body,
        });
      }
      throw e;
    }

    return safeTxHash;
  }

  async getSafeTransactionReceipt(chainId: string, safeHash: string): Promise<undefined | ITransactionReceipt> {
    // Initialize the API Kit
    const { apiKit, txServiceUrl } = this.getSafeApiKit(chainId);

    let safeTransaction: SafeMultisigTransactionResponse | undefined = undefined;
    try {
      safeTransaction = (await apiKit.getTransaction(safeHash)) as SafeMultisigTransactionResponse;
    } catch (e) {
      this.logger.warn('Failed to get transaction receipt with Safe API Kit, trying axios', {
        error: jsonifyError(e),
        txServiceUrl,
      });

      const url = `${txServiceUrl}/api/v2/multisig-transactions/${safeHash}`;
      try {
        const { data } = await axiosGet<SafeMultisigTransactionResponse>(url, undefined, 1, 100);
        safeTransaction = data;
      } catch (err) {
        this.logger.error('Failed to get transaction with axios', {
          error: jsonifyError(err),
          url,
        });
        throw e;
      }
    }

    if (!safeTransaction) {
      return undefined;
    }

    // Initialize the safe sdk
    const provider = new providers.FallbackProvider(
      this.config.chains[chainId].providers.map((p) => new providers.JsonRpcProvider(p)),
      1,
    );
    const safe = await Safe.create({
      safeAddress: safeTransaction.safe,
      ethAdapter: new EthersAdapter({ ethers, signerOrProvider: provider }),
    });

    // Get the current nonce of the safe. If the nonce is past the safe transaction, and the
    // safe transaction is not executed, it will not be able to be executed
    const currentNonce = await safe.getNonce();
    if (currentNonce > safeTransaction.nonce && !safeTransaction.isExecuted) {
      throw new Error(`Safe transaction (${safeHash}) cannot be executed, likely cancelled.`);
    }

    // Otherwise, can still be validly executed
    if (!safeTransaction.isExecuted) {
      return undefined;
    }

    if (!safeTransaction.transactionHash) {
      throw new Error(`Safe transaction (${safeHash}) is executed without transaction hash!`);
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

  private getSafeApiKit(chainId: string): { apiKit: SafeApiKit; txServiceUrl: string } {
    // Initialize the API Kit
    const txServiceUrl = this.config.chains[chainId].safeTxService;
    if (!txServiceUrl) {
      throw new Error(`Need a txservice url to propose multisig transaction`);
    }

    const apiKit = new SafeApiKit({
      chainId: BigInt(chainId),
      txServiceUrl,
    });
    return { apiKit, txServiceUrl };
  }

  private async getNextMultisigTransactionNonce(chainId: string, sdk: Safe): Promise<number> {
    const current = await sdk.getNonce();
    const safeAddress = await sdk.getAddress();
    const { apiKit, txServiceUrl } = this.getSafeApiKit(chainId.toString());

    let pending: { nonce: number }[];
    try {
      const results = await apiKit.getPendingTransactions(safeAddress, { currentNonce: current });
      pending = results.results;
    } catch (e) {
      this.logger.warn('Failed to get pending transactions, attempting with axios', {
        error: jsonifyError(e),
        txServiceUrl,
      });

      const url = `${txServiceUrl}/api/v1/safes/${safeAddress}/multisig-transactions?executed=false&nonce__gte=${current}`;
      const { data } = await axiosGet(url, undefined, 1, 100);
      pending = (data as unknown as { results: { nonce: number }[] }).results;
    }
    this.logger.debug('Got pending safe transactions', { pending, current });
    const [latest] = pending.sort((a, b) => b.nonce - a.nonce);
    const nonce = latest?.nonce;
    return nonce ? nonce + 1 : current;
  }
}
