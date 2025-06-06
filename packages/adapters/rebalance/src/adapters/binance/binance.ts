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
import { RebalanceCache } from '@mark/cache';
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
    private readonly rebalanceCache: RebalanceCache,
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

  /**
   * Look up recipient address from the rebalance cache by transaction hash
   */
  private async getRecipientFromCache(transactionHash: string): Promise<string | undefined> {
    try {
      const action = await this.rebalanceCache.getRebalanceByTransaction(transactionHash);

      if (action?.recipient) {
        this.logger.debug('Found recipient in cache', {
          transactionHash,
          recipient: action.recipient,
        });
        return action.recipient;
      }

      this.logger.debug('No recipient found in cache for transaction', {
        transactionHash,
      });
      return undefined;
    } catch (error) {
      this.logger.error('Failed to lookup recipient from cache', {
        error: jsonifyError(error),
        transactionHash,
      });
      return undefined;
    }
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
        throw new Error(
          `Amount ${amount} does not meet minimum withdrawal requirement of ${assetMapping.minWithdrawalAmount}`,
        );
      }

      // Get deposit address from Binance
      const depositInfo = await this.client.getDepositAddress(assetMapping.binanceSymbol, assetMapping.network);

      this.logger.debug('Binance deposit address obtained', {
        coin: assetMapping.binanceSymbol,
        network: assetMapping.network,
        address: depositInfo.address,
        amount,
        recipient,
      });

      // Return transaction to send funds to Binance deposit address
      return {
        to: depositInfo.address as `0x${string}`,
        value: route.asset === zeroAddress ? BigInt(amount) : BigInt(0),
        data:
          route.asset !== zeroAddress
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
      // Look up recipient from cache
      const recipient = await this.getRecipientFromCache(originTransaction.transactionHash);
      if (!recipient) {
        this.logger.error('No recipient found in cache for transaction', {
          transactionHash: originTransaction.transactionHash,
          route,
        });
        return false;
      }

      // Check if withdrawal is complete (will initiate if needed)
      const withdrawalStatus = await this.getOrInitWithdrawal(route, originTransaction, amount, recipient);

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
    this.logger.debug('destinationCallback called - TODO: wrap to WETH', {
      route,
      transactionHash: originTransaction.transactionHash,
    });
    return;
  }

  /**
   * Helper method to get withdrawal status or initiates withdrawal if needed
   */
  protected async getOrInitWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
    recipient: string,
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
        withdrawal = await this.initiateWithdrawal(route, originTransaction, amount, destinationMapping, recipient);
      }

      // Check withdrawal status
      const withdrawals = await this.client.getWithdrawHistory(destinationMapping.binanceSymbol);
      const currentWithdrawal = withdrawals.find((w) => w.id === withdrawal.id);

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
    assetMapping: BinanceAssetMapping,
  ): Promise<{ confirmed: boolean }> {
    try {
      // Check Binance deposit history for this transaction
      const deposits = await this.client.getDepositHistory(assetMapping.binanceSymbol, DEPOSIT_STATUS.SUCCESS);

      const matchingDeposit = deposits.find(
        (d) => d.txId.toLowerCase() === originTransaction.transactionHash.toLowerCase(),
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
    assetMapping: BinanceAssetMapping,
  ): Promise<{ id: string } | undefined> {
    try {
      // Generate the same withdrawal order ID we would use
      const expectedOrderId = generateWithdrawOrderId(route, originTransaction.transactionHash);

      // Check if withdrawal already exists with this custom order ID
      // When we pass withdrawOrderId to getWithdrawHistory, it filters to only that specific withdrawal
      const withdrawals = await this.client.getWithdrawHistory(assetMapping.binanceSymbol, expectedOrderId);

      // If any withdrawals are returned, it means our custom order ID exists
      if (withdrawals.length > 0) {
        const existingWithdrawal = withdrawals[0];
        this.logger.debug('Found existing withdrawal', {
          withdrawalId: existingWithdrawal.id,
          customOrderId: expectedOrderId,
          status: existingWithdrawal.status,
        });
        return { id: existingWithdrawal.id };
      }

      this.logger.debug('No existing withdrawal found', {
        customOrderId: expectedOrderId,
        coin: assetMapping.binanceSymbol,
      });

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
    assetMapping: BinanceAssetMapping,
    recipient: string,
  ): Promise<{ id: string }> {
    try {
      // Check Binance system status before proceeding with withdrawal
      const isOperational = await this.client.isSystemOperational();
      if (!isOperational) {
        throw new Error('Binance system is not operational - cannot initiate withdrawal');
      }

      this.logger.debug('Using recipient address', {
        recipient,
        route,
      });

      const withdrawOrderId = generateWithdrawOrderId(route, originTransaction.transactionHash);

      // Calculate the amount to withdraw (after fees)
      const withdrawAmount = calculateNetAmount(amount, assetMapping.withdrawalFee);

      this.logger.debug(`Initiating Binance withdrawal with id ${withdrawOrderId}`, {
        coin: assetMapping.binanceSymbol,
        network: assetMapping.network,
        address: recipient,
        amount: withdrawAmount,
        withdrawOrderId,
        originalAmount: amount,
        fee: assetMapping.withdrawalFee,
      });

      const withdrawal = await this.client.withdraw({
        coin: assetMapping.binanceSymbol,
        network: assetMapping.network,
        address: recipient,
        amount: withdrawAmount,
        withdrawOrderId,
      });

      this.logger.info('Binance withdrawal initiated', {
        withdrawalId: withdrawal.id,
        withdrawOrderId,
        coin: assetMapping.binanceSymbol,
        amount: withdrawAmount,
        recipient,
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
