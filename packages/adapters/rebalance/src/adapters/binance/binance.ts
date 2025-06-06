import {
  TransactionReceipt,
  TransactionRequestBase,
  createPublicClient,
  encodeFunctionData,
  http,
  zeroAddress,
  erc20Abi,
  PublicClient,
} from 'viem';
import { ChainConfiguration, SupportedBridge, RebalanceRoute } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter } from '../../types';
import { BinanceClient } from './client';
import { WithdrawalStatus, BinanceAssetMapping } from './types';
import { WITHDRAWAL_STATUS, DEPOSIT_STATUS } from './constants';
import {
  getAssetMapping,
  getDestinationAssetMapping,
  getAsset,
  findMatchingDestinationAsset,
  calculateNetAmount,
  validateAssetMapping,
  meetsMinimumWithdrawal,
  generateWithdrawOrderId,
  isWithdrawalStale,
} from './utils';

export class BinanceBridgeAdapter implements BridgeAdapter {
  private readonly client: BinanceClient;

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly baseUrl: string,
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.client = new BinanceClient(apiKey, apiSecret, baseUrl, logger);
    this.logger.debug('Initializing BinanceBridgeAdapter', { 
      baseUrl,
      hasApiKey: !!apiKey,
      hasApiSecret: !!apiSecret,
    });

    if (!this.client.isConfigured()) {
      throw new Error('Binance adapter requires API key and secret');
    }
  }

  type(): SupportedBridge {
    return SupportedBridge.Binance;
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      const originMapping = getAssetMapping(route);
      validateAssetMapping(originMapping, `route from chain ${route.origin}`);

      const destinationMapping = getDestinationAssetMapping(route);
      validateAssetMapping(destinationMapping, `route to chain ${route.destination}`);

      // Check if amount meets minimum requirements
      if (!meetsMinimumWithdrawal(amount, originMapping)) {
        throw new Error('Amount is too low for Binance withdrawal');
      }

      // Calculate net amount after withdrawal fee (using destination mapping for destination fees)
      const netAmount = calculateNetAmount(amount, destinationMapping.withdrawalFee);

      this.logger.debug('Calculated received amount', {
        originalAmount: amount,
        withdrawalFee: destinationMapping.withdrawalFee,
        netAmount,
        route,
      });

      return netAmount;
    } catch (error) {
      this.handleError(error, 'calculate received amount', { amount, route });
    }
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<TransactionRequestBase> {
    try {
      // Check Binance system status before proceeding
      const isOperational = await this.client.isSystemOperational();
      if (!isOperational) {
        throw new Error('Binance system is not operational');
      }

      const assetMapping = getAssetMapping(route);
      validateAssetMapping(assetMapping, `route from chain ${route.origin}`);

      // Check minimum amount requirements
      if (!meetsMinimumWithdrawal(amount, assetMapping)) {
        throw new Error(`Amount ${amount} does not meet minimum withdrawal requirement of ${assetMapping.minWithdrawalAmount}`);
      }

      // Get deposit address from Binance
      const depositInfo = await this.client.getDepositAddress(
        assetMapping.binanceSymbol,
        assetMapping.network
      );

      this.logger.debug('Binance deposit address obtained', {
        coin: assetMapping.binanceSymbol,
        network: assetMapping.network,
        address: depositInfo.address,
        amount,
      });

      // Return transaction to send funds to Binance deposit address
      return {
        to: depositInfo.address as `0x${string}`,
        value: route.asset === zeroAddress ? BigInt(amount) : BigInt(0),
        data: route.asset !== zeroAddress
          ? encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [depositInfo.address as `0x${string}`, BigInt(amount)],
            })
          : '0x',
      };
    } catch (error) {
      this.handleError(error, 'prepare Binance deposit transaction', { amount, route });
    }
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    this.logger.debug('readyOnDestination called', {
      amount,
      route,
      transactionHash: originTransaction.transactionHash,
    });

    try {
      // Check if withdrawal is complete
      const withdrawalStatus = await this.getWithdrawalStatus(route, originTransaction, amount);
      
      if (!withdrawalStatus) {
        return false;
      }
      
      // Return true if withdrawal is complete and confirmed on-chain
      const isReady = withdrawalStatus.status === 'completed' && withdrawalStatus.onChainConfirmed;
      this.logger.debug('Withdrawal ready status determined', {
        isReady,
        withdrawalStatus,
      });
      
      return isReady;
    } catch (error) {
      this.logger.error('Failed to check if transaction is ready on destination', {
        error: jsonifyError(error),
        amount,
        route,
        transactionHash: originTransaction.transactionHash,
      });
      return false;
    }
  }

  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<TransactionRequestBase | void> {
    // Binance handles withdrawals automatically - no callback needed
    this.logger.debug('destinationCallback called - no action needed for Binance', {
      route,
      transactionHash: originTransaction.transactionHash,
    });
    return;
  }

  /**
   * Helper method to check withdrawal status - similar to Across getDepositStatus
   */
  protected async getWithdrawalStatus(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
  ): Promise<WithdrawalStatus | undefined> {
    try {
      const originMapping = getAssetMapping(route);
      validateAssetMapping(originMapping, `route from chain ${route.origin}`);

      const destinationMapping = getDestinationAssetMapping(route);
      validateAssetMapping(destinationMapping, `route to chain ${route.destination}`);

      // Check if deposit is confirmed first
      const depositStatus = await this.checkDepositConfirmed(route, originTransaction, originMapping);
      if (!depositStatus.confirmed) {
        this.logger.debug('Deposit not yet confirmed', {
          transactionHash: originTransaction.transactionHash,
        });
        return undefined;
      }

      // Check if withdrawal exists, if not initiate it
      let withdrawal = await this.findExistingWithdrawal(route, originTransaction, destinationMapping);
      if (!withdrawal) {
        withdrawal = await this.initiateWithdrawal(route, originTransaction, amount, destinationMapping);
      }

      // Check withdrawal status
      const withdrawals = await this.client.getWithdrawHistory(destinationMapping.binanceSymbol);
      const currentWithdrawal = withdrawals.find(w => w.id === withdrawal.id);
      
      if (!currentWithdrawal) {
        return {
          status: 'pending',
          onChainConfirmed: false,
        };
      }

      // Check for stale withdrawals
      if (isWithdrawalStale(currentWithdrawal.applyTime)) {
        this.logger.warn('Withdrawal is taking longer than expected', {
          withdrawalId: withdrawal.id,
          applyTime: currentWithdrawal.applyTime,
          status: currentWithdrawal.status,
        });
      }

      // Verify on-chain if completed
      let onChainConfirmed = false;
      if (currentWithdrawal.status === WITHDRAWAL_STATUS.COMPLETED && currentWithdrawal.txId) {
        const provider = this.getProvider(route.destination);
        if (provider) {
          try {
            const receipt = await provider.getTransactionReceipt({
              hash: currentWithdrawal.txId as `0x${string}`,
            });
            onChainConfirmed = receipt !== null && receipt.status === 'success';
          } catch (error) {
            this.logger.debug('Could not verify on-chain confirmation', {
              txId: currentWithdrawal.txId,
              error: jsonifyError(error),
            });
          }
        }
      }

      return {
        status: currentWithdrawal.status === WITHDRAWAL_STATUS.COMPLETED ? 'completed' : 'pending',
        onChainConfirmed,
        txId: currentWithdrawal.txId || undefined,
      };
    } catch (error) {
      this.logger.error('Failed to get withdrawal status', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
      throw error;
    }
  }

  /**
   * Check if deposit is confirmed on Binance
   */
  protected async checkDepositConfirmed(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    assetMapping: BinanceAssetMapping
  ): Promise<{ confirmed: boolean }> {
    try {
      // Check Binance deposit history for this transaction
      const deposits = await this.client.getDepositHistory(
        assetMapping.binanceSymbol,
        DEPOSIT_STATUS.SUCCESS
      );
      
      const matchingDeposit = deposits.find(d => 
        d.txId.toLowerCase() === originTransaction.transactionHash.toLowerCase()
      );
      
      const confirmed = !!matchingDeposit;
      this.logger.debug('Deposit confirmation check', {
        transactionHash: originTransaction.transactionHash,
        confirmed,
        matchingDepositId: matchingDeposit?.txId,
      });
      
      return { confirmed };
    } catch (error) {
      this.logger.error('Failed to check deposit confirmation', {
        error: jsonifyError(error),
        transactionHash: originTransaction.transactionHash,
      });
      return { confirmed: false };
    }
  }

  /**
   * Find existing withdrawal for this route and transaction
   */
  protected async findExistingWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    assetMapping: BinanceAssetMapping
  ): Promise<{ id: string } | undefined> {
    try {
      // Generate the same withdrawal order ID we would use
      const expectedOrderId = generateWithdrawOrderId(route, originTransaction.transactionHash);
      
      // Check if withdrawal already exists with this order ID
      const withdrawals = await this.client.getWithdrawHistory(
        assetMapping.binanceSymbol,
        expectedOrderId
      );
      
      const existingWithdrawal = withdrawals.find(w => w.id === expectedOrderId);
      
      if (existingWithdrawal) {
        this.logger.debug('Found existing withdrawal', {
          withdrawalId: existingWithdrawal.id,
          status: existingWithdrawal.status,
        });
        return { id: existingWithdrawal.id };
      }
      
      return undefined;
    } catch (error) {
      this.logger.error('Failed to find existing withdrawal', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
      return undefined;
    }
  }

  /**
   * Initiate withdrawal to destination chain
   */
  protected async initiateWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
    assetMapping: BinanceAssetMapping
  ): Promise<{ id: string }> {
    try {
      // Check Binance system status before proceeding with withdrawal
      const isOperational = await this.client.isSystemOperational();
      if (!isOperational) {
        throw new Error('Binance system is not operational - cannot initiate withdrawal');
      }

      const destinationAddress = this.getDestinationAddress(route);
      const withdrawOrderId = generateWithdrawOrderId(route, originTransaction.transactionHash);
      
      // Calculate the amount to withdraw (after fees)
      const withdrawAmount = calculateNetAmount(amount, assetMapping.withdrawalFee);
      
      this.logger.debug('Initiating Binance withdrawal', {
        coin: assetMapping.binanceSymbol,
        network: assetMapping.network,
        address: destinationAddress,
        amount: withdrawAmount,
        withdrawOrderId,
        originalAmount: amount,
        fee: assetMapping.withdrawalFee,
      });
      
      const withdrawal = await this.client.withdraw({
        coin: assetMapping.binanceSymbol,
        network: assetMapping.network,
        address: destinationAddress,
        amount: withdrawAmount,
        withdrawOrderId,
      });
      
      this.logger.info('Binance withdrawal initiated', {
        withdrawalId: withdrawal.id,
        withdrawOrderId,
        coin: assetMapping.binanceSymbol,
        amount: withdrawAmount,
        destinationAddress,
      });
      
      return { id: withdrawal.id };
    } catch (error) {
      this.logger.error('Failed to initiate withdrawal', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
        assetMapping,
      });
      throw error;
    }
  }

  /**
   * Get destination address for withdrawal
   * For now, this assumes withdrawals go to a fixed address per chain
   * In the future, this could be configurable per route
   */
  protected getDestinationAddress(route: RebalanceRoute): string {
    // This would typically be Mark's address on the destination chain
    // For now, we'll use a placeholder - this should be configurable
    const destinationChain = this.chains[route.destination.toString()];
    if (!destinationChain) {
      throw new Error(`No configuration found for destination chain ${route.destination}`);
    }
    
    // This should be configurable - perhaps in the chain configuration
    // For now, throwing an error to indicate this needs to be implemented
    throw new Error(
      'Destination address configuration not implemented. ' +
      'This should be configured per chain or per route.'
    );
  }

  /**
   * Get viem provider for a specific chain
   */
  protected getProvider(chainId: number): PublicClient | undefined {
    const chainConfig = this.chains[chainId.toString()];
    if (!chainConfig || !chainConfig.providers || chainConfig.providers.length === 0) {
      this.logger.warn('No provider configured for chain', { chainId });
      return undefined;
    }

    try {
      return createPublicClient({
        transport: http(chainConfig.providers[0]),
      });
    } catch (error) {
      this.logger.error('Failed to create provider', {
        error: jsonifyError(error),
        chainId,
        provider: chainConfig.providers[0],
      });
      return undefined;
    }
  }

  /**
   * Error handling helper - similar to Across pattern
   */
  protected handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...metadata,
    });
    throw new Error(`Failed to ${context}: ${(error as any)?.message ?? 'Unknown error'}`);
  }
} 