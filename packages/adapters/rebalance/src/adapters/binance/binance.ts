import {
  TransactionReceipt,
  createPublicClient,
  encodeFunctionData,
  http,
  zeroAddress,
  erc20Abi,
  PublicClient,
  formatUnits,
  parseUnits,
} from 'viem';
import { SupportedBridge, RebalanceRoute, MarkConfiguration, getDecimalsFromConfig } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { RebalanceCache } from '@mark/cache';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { BinanceClient } from './client';
import { DynamicAssetConfig } from './dynamic-config';
import { WithdrawalStatus, BinanceAssetMapping } from './types';
import { WITHDRAWAL_STATUS, DEPOSIT_STATUS, WITHDRAWAL_PRECISION_MAP } from './constants';
import {
  getDestinationAssetMapping,
  calculateNetAmount,
  validateAssetMapping,
  meetsMinimumWithdrawal,
  generateWithdrawOrderId,
  checkWithdrawQuota,
} from './utils';
import { getDestinationAssetAddress, findAssetByAddress } from '../../shared/asset';

const wethAbi = [
  ...erc20Abi,
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'wad', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [],
    outputs: [],
  },
] as const;

export class BinanceBridgeAdapter implements BridgeAdapter {
  private readonly client: BinanceClient;
  private readonly dynamicConfig: DynamicAssetConfig;

  constructor(
    apiKey: string,
    apiSecret: string,
    baseUrl: string,
    protected readonly config: MarkConfiguration,
    protected readonly logger: Logger,
    private readonly rebalanceCache: RebalanceCache,
  ) {
    this.client = new BinanceClient(apiKey, apiSecret, baseUrl, logger);
    this.dynamicConfig = new DynamicAssetConfig(this.client, this.config.chains);

    this.logger.debug('Initializing BinanceBridgeAdapter', {
      baseUrl,
      hasApiKey: !!apiKey,
      hasApiSecret: !!apiSecret,
    });

    if (!this.client.isConfigured()) {
      throw new Error('Binance adapter requires API key and secret');
    }
  }

  /**
   * Get withdrawal precision for an asset from Binance API
   * Returns the number of decimal places required for withdrawal amounts
   */
  private getWithdrawalPrecision(coin: string, network: string): number {
    const coinPrecision = WITHDRAWAL_PRECISION_MAP[coin];
    if (coinPrecision && coinPrecision[network]) {
      return coinPrecision[network];
    }

    // Default fallback to 8 decimal places
    this.logger.warn(`No precision mapping found for ${coin} on ${network}, using default precision`);
    return 8;
  }

  /**
   * Round amount to specified precision to ensure we don't exceed available balance
   * @param amount - The amount to round
   * @param precision - Number of decimal places
   * @returns Rounded amount as string
   */
  private roundToPrecision(amount: number, precision: number): string {
    const multiplier = Math.pow(10, precision);
    const rounded = Math.floor(amount * multiplier) / multiplier;
    return rounded.toFixed(precision);
  }

  /**
   * Calculate the rounded amount in wei for deposits to match withdrawal rounding
   * @param amount - Original amount in wei
   * @param coin - Binance coin symbol
   * @param network - Binance network
   * @param decimals - Token decimals
   * @returns Rounded amount in wei
   */
  private getRoundedDepositAmount(amount: string, coin: string, network: string, decimals: number): string {
    const amountInUnits = parseFloat(formatUnits(BigInt(amount), decimals));
    const precision = this.getWithdrawalPrecision(coin, network);
    const roundedAmount = this.roundToPrecision(amountInUnits, precision);
    const roundedAmountInWei = parseUnits(roundedAmount, decimals);

    return roundedAmountInWei.toString();
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
      const originMapping = await validateAssetMapping(
        this.client,
        route,
        `route from chain ${route.origin}`,
        this.config.chains,
      );
      const destinationMapping = await getDestinationAssetMapping(this.client, route, this.config.chains);

      // Check if amount meets minimum requirements
      if (!meetsMinimumWithdrawal(amount, originMapping)) {
        throw new Error('Amount is too low for Binance withdrawal');
      }

      // Calculate net amount after withdrawal fee
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
    _sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      // Check Binance system status before proceeding
      const isOperational = await this.client.isSystemOperational();
      if (!isOperational) {
        throw new Error('Binance system is not operational');
      }

      const assetMapping = await validateAssetMapping(
        this.client,
        route,
        `route from chain ${route.origin}`,
        this.config.chains,
      );

      // Check minimum amount requirements
      if (!meetsMinimumWithdrawal(amount, assetMapping)) {
        throw new Error(
          `Amount ${amount} does not meet minimum withdrawal requirement of ${assetMapping.minWithdrawalAmount}`,
        );
      }

      const assetConfig = findAssetByAddress(route.asset, route.origin, this.config.chains, this.logger);
      if (!assetConfig) {
        throw new Error(`Unable to find asset config for asset ${route.asset} on chain ${route.origin}`);
      }
      const ticker = assetConfig.tickerHash;
      const decimals = getDecimalsFromConfig(ticker, route.origin.toString(), this.config);
      if (!decimals) {
        throw new Error(`Unable to find decimals for ticker ${ticker} on chain ${route.origin}`);
      }

      const quota = await checkWithdrawQuota(amount, assetMapping.binanceSymbol, decimals, this.client);

      this.logger.debug('Withdrawal quota', {
        amountUSD: quota.amountUSD,
        remainingQuotaUSD: quota.remainingQuotaUSD,
        coin: assetMapping.binanceSymbol,
      });

      if (!quota.allowed) {
        throw new Error(
          `Withdrawal amount $${quota.amountUSD.toFixed(2)} USD exceeds remaining daily quota of $${quota.remainingQuotaUSD.toFixed(2)} USD`,
        );
      }

      const depositInfo = await this.client.getDepositAddress(assetMapping.binanceSymbol, assetMapping.network);

      // Calculate rounded deposit amount to match withdrawal rounding
      const roundedAmount = this.getRoundedDepositAmount(
        amount,
        assetMapping.binanceSymbol,
        assetMapping.network,
        decimals,
      );

      this.logger.debug('Binance deposit address obtained', {
        coin: assetMapping.binanceSymbol,
        network: assetMapping.network,
        address: depositInfo.address,
        amount,
        roundedAmount,
        recipient,
      });

      const transactions: MemoizedTransactionRequest[] = [];

      // Unwrap WETH to ETH before deposit (only if route asset is different from Binance asset)
      if (
        assetMapping.binanceSymbol === 'ETH' &&
        route.asset !== zeroAddress &&
        route.asset.toLowerCase() !== assetMapping.binanceAsset.toLowerCase()
      ) {
        this.logger.debug('Preparing WETH unwrap transaction before Binance deposit', {
          wethAddress: route.asset,
          amount,
        });
        const unwrapTx = {
          memo: RebalanceTransactionMemo.Unwrap,
          transaction: {
            to: route.asset as `0x${string}`,
            data: encodeFunctionData({
              abi: wethAbi,
              functionName: 'withdraw',
              args: [BigInt(roundedAmount)],
            }) as `0x${string}`,
            value: BigInt(0),
            funcSig: 'withdraw(uint256)',
          },
        };
        const sendToBinanceTx = {
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: depositInfo.address as `0x${string}`,
            value: BigInt(roundedAmount),
            data: '0x' as `0x${string}`,
            funcSig: '', // Native ETH transfer doesn't need function signature
          },
        };
        return [unwrapTx, sendToBinanceTx];
      } else if (assetMapping.binanceSymbol === 'ETH') {
        // WETH without unwrapping - check if Binance accepts native ETH or WETH token
        const binanceTakesNativeETH = assetMapping.binanceAsset === zeroAddress;

        if (binanceTakesNativeETH) {
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: depositInfo.address as `0x${string}`,
              value: BigInt(roundedAmount),
              data: '0x' as `0x${string}`,
            },
          });
        } else {
          // BSC: Transfer WETH to Binance
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: route.asset as `0x${string}`,
              value: BigInt(0),
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [depositInfo.address as `0x${string}`, BigInt(roundedAmount)],
              }),
            },
          });
        }
      } else {
        // For all other assets (i.e. USDC, USDT), transfer token
        transactions.push({
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: route.asset as `0x${string}`,
            value: BigInt(0),
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [depositInfo.address as `0x${string}`, BigInt(roundedAmount)],
            }),
            funcSig: route.asset !== zeroAddress ? 'transfer(address,uint256)' : '',
          },
        });
      }

      return transactions;
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
      const recipient = await this.getRecipientFromCache(originTransaction.transactionHash);
      if (!recipient) {
        this.logger.error('No recipient found in cache for withdrawal', {
          transactionHash: originTransaction.transactionHash,
          route,
        });
        return false;
      }

      const withdrawalStatus = await this.getOrInitWithdrawal(route, originTransaction, amount, recipient);

      if (!withdrawalStatus) {
        return false;
      }

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
  ): Promise<MemoizedTransactionRequest | void> {
    this.logger.debug('destinationCallback called', {
      route,
      transactionHash: originTransaction.transactionHash,
    });

    try {
      // Look up recipient from cache
      const recipient = await this.getRecipientFromCache(originTransaction.transactionHash);
      if (!recipient) {
        this.logger.error('No recipient found in cache for callback', {
          transactionHash: originTransaction.transactionHash,
        });
        return;
      }

      const withdrawalStatus = await this.getOrInitWithdrawal(route, originTransaction, '0', recipient);
      if (!withdrawalStatus || withdrawalStatus.status !== 'completed' || !withdrawalStatus.txId) {
        this.logger.debug('Withdrawal not completed yet, skipping callback', {
          withdrawalStatus,
        });
        return;
      }

      // Get the withdrawal transaction details to find the amount
      const provider = this.getProvider(route.destination);
      if (!provider) {
        this.logger.error('No provider for destination chain', { chainId: route.destination });
        return;
      }

      const withdrawalTx = await provider.getTransaction({
        hash: withdrawalStatus.txId as `0x${string}`,
      });

      if (!withdrawalTx) {
        this.logger.error('Could not fetch withdrawal transaction', { txId: withdrawalStatus.txId });
        return;
      }

      const ethAmount = withdrawalTx.value;
      if (ethAmount === BigInt(0)) {
        this.logger.debug('No ETH value in withdrawal transaction, skipping wrap', {
          txId: withdrawalStatus.txId,
        });
        return;
      }

      const destinationMapping = await getDestinationAssetMapping(this.client, route, this.config.chains);

      // Get the destination asset address that Mark should hold
      const destinationAsset = getDestinationAssetAddress(
        route.asset,
        route.origin,
        route.destination,
        this.config.chains,
        this.logger,
      );
      if (!destinationAsset) {
        this.logger.error('Could not find destination asset address for ticker', {
          originAsset: route.asset,
          originChain: route.origin,
          destinationChain: route.destination,
        });
        return;
      }

      // No wrapping needed if Binance withdrawal asset matches the destination asset Mark should hold
      if (destinationMapping.binanceAsset.toLowerCase() === destinationAsset.toLowerCase()) {
        this.logger.debug('Binance withdrawal asset matches destination asset, no wrapping needed', {
          destinationAsset,
          binanceAsset: destinationMapping.binanceAsset,
        });
        return;
      }

      this.logger.info('Preparing WETH wrap callback', {
        recipient,
        ethAmount: ethAmount.toString(),
        wethAddress: destinationAsset,
        destinationChain: route.destination,
      });

      // Wrap ETH to WETH on the destination chain after withdrawal if needed
      const wrapTx = {
        memo: RebalanceTransactionMemo.Wrap,
        transaction: {
          to: destinationAsset as `0x${string}`,
          data: encodeFunctionData({
            abi: wethAbi,
            functionName: 'deposit',
            args: [],
          }) as `0x${string}`,
          value: ethAmount,
          funcSig: 'deposit()',
        },
      };
      return wrapTx;
    } catch (error) {
      this.logger.error('Failed to prepare destination callback', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
      return;
    }
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
      const originMapping = await validateAssetMapping(
        this.client,
        route,
        `route from chain ${route.origin}`,
        this.config.chains,
      );
      const destinationMapping = await getDestinationAssetMapping(this.client, route, this.config.chains);

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
    _route: RebalanceRoute,
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

      // Use the full amount for withdrawal - Binance will deduct fees automatically
      const withdrawAmount = amount;

      // Check withdrawal quota before initiating (use full amount for quota check)
      const assetConfig = findAssetByAddress(route.asset, route.origin, this.config.chains, this.logger);
      if (!assetConfig) {
        throw new Error(`Unable to find asset config for asset ${route.asset} on chain ${route.origin}`);
      }
      const ticker = assetConfig.tickerHash;
      const decimals = getDecimalsFromConfig(ticker, route.origin.toString(), this.config);
      if (!decimals) {
        throw new Error(`Unable to find decimals for ticker ${ticker} on chain ${route.origin}`);
      }
      const quota = await checkWithdrawQuota(withdrawAmount, assetMapping.binanceSymbol, decimals, this.client);

      if (!quota.allowed) {
        throw new Error(
          `Withdrawal amount $${quota.amountUSD.toFixed(2)} USD exceeds remaining daily quota of $${quota.remainingQuotaUSD.toFixed(2)} USD`,
        );
      }

      // Convert amount from wei to standard unit for Binance API
      // Get the proper withdrawal precision from Binance API configuration
      const withdrawAmountInUnits = parseFloat(formatUnits(BigInt(withdrawAmount), decimals));
      const withdrawalPrecision = this.getWithdrawalPrecision(assetMapping.binanceSymbol, assetMapping.network);
      const withdrawAmountFormatted = this.roundToPrecision(withdrawAmountInUnits, withdrawalPrecision);

      this.logger.debug(`Initiating Binance withdrawal with id ${withdrawOrderId}`, {
        coin: assetMapping.binanceSymbol,
        network: assetMapping.network,
        address: recipient,
        amount: withdrawAmount,
        amountFormatted: withdrawAmountFormatted,
        withdrawOrderId,
        originalAmount: amount,
        fee: assetMapping.withdrawalFee,
      });

      const withdrawal = await this.client.withdraw({
        coin: assetMapping.binanceSymbol,
        network: assetMapping.network,
        address: recipient,
        amount: withdrawAmountFormatted,
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
    const chainConfig = this.config.chains[chainId.toString()];
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
    throw new Error(`Failed to ${context}: ${(error as unknown as Error)?.message ?? 'Unknown error'}`);
  }
}
