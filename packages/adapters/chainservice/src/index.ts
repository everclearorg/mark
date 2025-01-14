import { Logger } from '@mark/logger-adapter';
import { ethers } from 'ethers';

export interface ChainConfig {
  rpcUrl: string;
}

export abstract class ChainReader {
  protected readonly provider: ethers.JsonRpcProvider;
  protected readonly logger: Logger;

  constructor(config: ChainConfig, logger: Logger) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.logger = logger;
  }

  async getBlock(blockNumber: number) {
    return this.provider.getBlock(blockNumber);
  }

  async getTransaction(txHash: string) {
    return this.provider.getTransaction(txHash);
  }

  async getTransactionReceipt(txHash: string) {
    return this.provider.getTransactionReceipt(txHash);
  }
}

export interface ChainServiceConfig extends ChainConfig {
  contractAddress: string;
}

export class ChainServiceAdapter extends ChainReader {
  private readonly contractAddress: string;
  private isInitialized: boolean = false;

  constructor(config: ChainServiceConfig, logger: Logger) {
    super(config, logger);
    this.contractAddress = config.contractAddress;
  }

  async initialize() {
    if (this.isInitialized) return;

    try {
      await this.provider.getNetwork();
      this.isInitialized = true;
      this.logger.info('Chain service initialized', { contractAddress: this.contractAddress });
    } catch (error) {
      this.logger.error('Failed to initialize chain service', { error });
      throw error;
    }
  }

  async submitTransaction(transaction: ethers.TransactionRequest) {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const tx = await this.provider.broadcastTransaction(await this.prepareTransaction(transaction));
      this.logger.info('Transaction submitted', { txHash: tx.hash });
      return tx;
    } catch (error) {
      this.logger.error('Failed to submit transaction', { error });
      throw error;
    }
  }

  private async prepareTransaction(tx: ethers.TransactionRequest): Promise<string> {
    if (!tx.to) tx.to = this.contractAddress;
    if (!tx.chainId) {
      const network = await this.provider.getNetwork();
      tx.chainId = network.chainId;
    }
    return tx as string; // In reality, this would be properly serialized
  }

  async dispose() {
    this.provider.destroy();
    this.isInitialized = false;
    this.logger.info('Chain service disposed');
  }
}
