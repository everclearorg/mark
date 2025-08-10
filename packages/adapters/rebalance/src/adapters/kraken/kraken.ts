import {
  TransactionReceipt,
  createPublicClient,
  encodeFunctionData,
  http,
  zeroAddress,
  erc20Abi,
  PublicClient,
  formatUnits,
} from 'viem';
import { SupportedBridge, RebalanceRoute, MarkConfiguration, getDecimalsFromConfig } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { RebalanceCache } from '@mark/cache';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { KrakenClient } from './client';
import { DynamicAssetConfig } from './dynamic-config';
import { WithdrawalStatus, KrakenAssetMapping, KRAKEN_WITHDRAWAL_STATUS, KRAKEN_DEPOSIT_STATUS } from './types';
import {
  validateAssetMapping,
  getDestinationAssetMapping,
  calculateNetAmount,
  meetsMinimumWithdrawal,
  generateWithdrawOrderId,
  checkWithdrawQuota,
  findAssetByAddress,
} from './utils';
import { getDestinationAssetAddress } from '../../shared/asset';

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

export class KrakenBridgeAdapter implements BridgeAdapter {
  private readonly client: KrakenClient;
  private readonly dynamicConfig: DynamicAssetConfig;

  constructor(
    apiKey: string, // TODO: remove
    apiSecret: string, // TODO: remove
    baseUrl: string,
    protected readonly config: MarkConfiguration,
    protected readonly logger: Logger,
    private readonly rebalanceCache: RebalanceCache,
  ) {
    this.client = new KrakenClient(config.kraken.apiKey!, config.kraken.apiSecret!, logger, baseUrl);
    if (!this.client.isConfigured()) {
      throw new Error('Kraken adapter requires API key and secret');
    }
    this.dynamicConfig = new DynamicAssetConfig(this.client, this.config.chains, this.logger);

    this.logger.debug('KrakenBridgeAdapter initialized', {
      baseUrl,
      hasApiKey: !!apiKey,
      hasApiSecret: !!apiSecret,
      bridgeType: SupportedBridge.Kraken,
      clientConfigured: this.client.isConfigured(),
    });
  }

  type(): SupportedBridge {
    return SupportedBridge.Kraken;
  }

  private async getRecipientFromCache(transactionHash: string): Promise<string | undefined> {
    try {
      const action = await this.rebalanceCache.getRebalanceByTransaction(transactionHash);

      if (action?.recipient) {
        this.logger.debug('Recipient found in rebalance cache', {
          transactionHash,
          recipient: action.recipient,
          cacheHit: true,
        });
        return action.recipient;
      }

      this.logger.debug('Recipient not found in rebalance cache', {
        transactionHash,
        cacheHit: false,
        action: 'withdraw_will_fail_without_recipient',
      });
      return undefined;
    } catch (error) {
      this.logger.error('Rebalance cache lookup failed for recipient', {
        error: jsonifyError(error),
        transactionHash,
        cacheOperation: 'getRebalanceByTransaction',
        action: 'withdraw_will_fail_without_recipient',
      });
      return undefined;
    }
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      await validateAssetMapping(this.dynamicConfig, route, `route from chain ${route.origin}`);
      const destinationMapping = await getDestinationAssetMapping(this.dynamicConfig, route);

      if (!meetsMinimumWithdrawal(amount, destinationMapping)) {
        throw new Error(`Amount is too low for Kraken withdrawal`);
      }

      const netAmount = calculateNetAmount(amount, destinationMapping.withdrawalFee);

      this.logger.debug('Kraken withdrawal amount calculated after fees', {
        originalAmount: amount,
        withdrawalFee: destinationMapping.withdrawalFee,
        netAmount,
        asset: destinationMapping.krakenAsset,
        method: destinationMapping.method,
        originChain: route.origin,
        destinationChain: route.destination,
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
      // Safety Check 1: Kraken system status
      const isOperational = await this.client.isSystemOperational();
      if (!isOperational) {
        throw new Error('Kraken system is not operational');
      }
      const originMapping = await validateAssetMapping(this.dynamicConfig, route, `route from chain ${route.origin}`);

      // Safety Check 2: Minimum amount validation for withdrawal on dest
      if (!meetsMinimumWithdrawal(amount, originMapping)) {
        throw new Error(
          `Amount ${amount} does not meet minimum withdrawal requirement of ${originMapping.minWithdrawalAmount}`,
        );
      }

      // Safety Check 3: Ensure asset is configured properly
      const originAssetConfig = findAssetByAddress(route.asset, route.origin, this.config.chains);
      if (!originAssetConfig) {
        throw new Error(`Unable to find asset config for asset ${route.asset} on chain ${route.origin}`);
      }
      const ticker = originAssetConfig.tickerHash;
      const decimals = getDecimalsFromConfig(ticker, route.origin.toString(), this.config);
      if (!decimals) {
        throw new Error(`Unable to find decimals for ticker ${ticker} on chain ${route.origin}`);
      }

      // Safety Check 3: Withdrawal quota validation
      const quota = await checkWithdrawQuota(amount, originMapping.krakenSymbol, decimals, this.client, this.logger);
      if (!quota.allowed) {
        throw new Error(quota.message || `Withdrawal amount exceeds limits`);
      }

      // Safety Check 4: Asset status validation
      const assetInfo = await this.client.getAssetInfo([originMapping.krakenAsset]);
      const krakenAsset = assetInfo[originMapping.krakenAsset];
      if (!krakenAsset || krakenAsset.status === 'disabled') {
        throw new Error(`Asset ${originMapping.krakenAsset} is not available on Kraken`);
      }

      // Safety Check 5: Deposit methods validation
      const depositMethods = await this.client.getDepositMethods(originMapping.krakenAsset);
      const validMethod = depositMethods.find((method) => method.method === originMapping.method);
      if (!validMethod) {
        throw new Error(`Deposit method ${originMapping.method} not available for ${originMapping.krakenAsset}`);
      }

      // Get deposit address
      const depositAddresses = await this.client.getDepositAddresses(originMapping.krakenAsset, originMapping.method);
      if (!depositAddresses || depositAddresses.length === 0) {
        throw new Error(`No deposit address available for ${originMapping.krakenAsset} on ${originMapping.method}`);
      }
      const depositAddress = depositAddresses[0].address;

      this.logger.debug('Kraken deposit address obtained for transaction preparation', {
        asset: originMapping.krakenAsset,
        krakenSymbol: originMapping.krakenSymbol,
        method: originMapping.method,
        depositAddress,
        amount,
        recipient,
        originChain: route.origin,
        destinationChain: route.destination,
        decimals,
      });

      const transactions: MemoizedTransactionRequest[] = [];

      // Handle ETH/WETH conversions similar to Binance adapter
      if (
        originMapping.krakenSymbol === 'ETH' &&
        route.asset !== zeroAddress &&
        route.asset.toLowerCase() !== originMapping.krakenAsset.toLowerCase()
      ) {
        // Unwrap WETH to ETH before deposit
        this.logger.debug('Preparing WETH unwrap before Kraken ETH deposit', {
          wethAddress: route.asset,
          amount,
          krakenAsset: originMapping.krakenAsset,
          krakenSymbol: originMapping.krakenSymbol,
          depositAddress,
          transactionSequence: ['unwrap_weth', 'send_eth_to_kraken'],
        });

        const unwrapTx = {
          memo: RebalanceTransactionMemo.Unwrap,
          transaction: {
            to: route.asset as `0x${string}`,
            data: encodeFunctionData({
              abi: wethAbi,
              functionName: 'withdraw',
              args: [BigInt(amount)],
            }) as `0x${string}`,
            value: BigInt(0),
          },
        };

        const sendToKrakenTx = {
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: depositAddress as `0x${string}`,
            value: BigInt(amount),
            data: '0x' as `0x${string}`,
          },
        };

        return [unwrapTx, sendToKrakenTx];
      } else if (originMapping.krakenSymbol === 'ETH') {
        // Handle native ETH deposit
        const krakenTakesNativeETH = originMapping.krakenAsset === zeroAddress;

        if (krakenTakesNativeETH) {
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: depositAddress as `0x${string}`,
              value: BigInt(amount),
              data: '0x' as `0x${string}`,
            },
          });
        } else {
          // Transfer WETH token to Kraken
          transactions.push({
            memo: RebalanceTransactionMemo.Rebalance,
            transaction: {
              to: route.asset as `0x${string}`,
              value: BigInt(0),
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [depositAddress as `0x${string}`, BigInt(amount)],
              }),
            },
          });
        }
      } else {
        // For all other assets (USDC, USDT, etc), transfer token
        transactions.push({
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: route.asset as `0x${string}`,
            value: BigInt(0),
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [depositAddress as `0x${string}`, BigInt(amount)],
            }),
          },
        });
      }

      return transactions;
    } catch (error) {
      this.handleError(error, 'prepare Kraken deposit transaction', { amount, route });
    }
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    this.logger.debug('Checking if Kraken withdrawal is ready on destination', {
      amount,
      originChain: route.origin,
      destinationChain: route.destination,
      asset: route.asset,
      transactionHash: originTransaction.transactionHash,
      blockNumber: originTransaction.blockNumber,
    });

    try {
      const recipient = await this.getRecipientFromCache(originTransaction.transactionHash);
      if (!recipient) {
        this.logger.error('Cannot check withdrawal readiness - recipient missing from cache', {
          transactionHash: originTransaction.transactionHash,
          originChain: route.origin,
          destinationChain: route.destination,
          asset: route.asset,
          blockNumber: originTransaction.blockNumber,
          requiredFor: 'kraken_withdrawal_initiation',
        });
        return false;
      }

      const withdrawalStatus = await this.getOrInitWithdrawal(route, originTransaction, amount, recipient);

      if (!withdrawalStatus) {
        return false;
      }

      const isReady = withdrawalStatus.status === 'completed' && withdrawalStatus.onChainConfirmed;
      this.logger.debug('Kraken withdrawal readiness determined', {
        isReady,
        krakenStatus: withdrawalStatus.status,
        onChainConfirmed: withdrawalStatus.onChainConfirmed,
        withdrawalTxId: withdrawalStatus.txId,
        transactionHash: originTransaction.transactionHash,
        recipient,
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

      const destinationMapping = await getDestinationAssetMapping(this.dynamicConfig, route);

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

      // No wrapping needed if Kraken withdrawal asset matches the destination asset Mark should hold
      if (destinationMapping.krakenAsset.toLowerCase() === destinationAsset.toLowerCase()) {
        this.logger.debug('Kraken withdrawal asset matches destination asset, no wrapping needed', {
          destinationAsset,
          krakenAsset: destinationMapping.krakenAsset,
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

  protected async getOrInitWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
    recipient: string,
  ): Promise<WithdrawalStatus | undefined> {
    try {
      const originMapping = await validateAssetMapping(this.dynamicConfig, route, `route from chain ${route.origin}`);
      const destinationMapping = await getDestinationAssetMapping(this.dynamicConfig, route);

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
      const withdrawals = await this.client.getWithdrawStatus(destinationMapping.krakenAsset);
      const currentWithdrawal = withdrawals.find((w) => w.refid === withdrawal.id);

      if (!currentWithdrawal) {
        return {
          status: 'pending',
          onChainConfirmed: false,
        };
      }

      // Verify on-chain if completed
      let onChainConfirmed = false;
      if (currentWithdrawal.status === KRAKEN_WITHDRAWAL_STATUS.SUCCESS && currentWithdrawal.txid) {
        const provider = this.getProvider(route.destination);
        if (provider) {
          try {
            const receipt = await provider.getTransactionReceipt({
              hash: currentWithdrawal.txid as `0x${string}`,
            });
            onChainConfirmed = receipt !== null && receipt.status === 'success';
          } catch (error) {
            this.logger.debug('Could not verify on-chain confirmation', {
              txId: currentWithdrawal.txid,
              error: jsonifyError(error),
            });
          }
        }
      }

      return {
        status: currentWithdrawal.status === KRAKEN_WITHDRAWAL_STATUS.SUCCESS ? 'completed' : 'pending',
        onChainConfirmed,
        txId: currentWithdrawal.txid || undefined,
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

  protected async checkDepositConfirmed(
    _route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    assetMapping: KrakenAssetMapping,
  ): Promise<{ confirmed: boolean }> {
    try {
      const deposits = await this.client.getDepositStatus(assetMapping.krakenAsset, assetMapping.method);

      const matchingDeposit = deposits.find(
        (d) => d.txid.toLowerCase() === originTransaction.transactionHash.toLowerCase(),
      );

      const confirmed = !!matchingDeposit && matchingDeposit.status === KRAKEN_DEPOSIT_STATUS.SUCCESS;
      this.logger.debug('Deposit confirmation check', {
        transactionHash: originTransaction.transactionHash,
        confirmed,
        matchingDepositId: matchingDeposit?.txid,
        status: matchingDeposit?.status,
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

  protected async findExistingWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    assetMapping: KrakenAssetMapping,
  ): Promise<{ id: string } | undefined> {
    try {
      const expectedOrderId = generateWithdrawOrderId(route, originTransaction.transactionHash);

      // Get all withdrawals for this asset and search for our custom ID
      const withdrawals = await this.client.getWithdrawStatus(assetMapping.krakenAsset);

      // Find withdrawal by checking the info field or reference ID patterns
      const existingWithdrawal = withdrawals.find(
        (w) => w.info?.includes(expectedOrderId) || w.refid === expectedOrderId,
      );

      if (existingWithdrawal) {
        this.logger.debug('Found existing withdrawal', {
          withdrawalId: existingWithdrawal.refid,
          customOrderId: expectedOrderId,
          status: existingWithdrawal.status,
        });
        return { id: existingWithdrawal.refid };
      }

      this.logger.debug('No existing withdrawal found', {
        customOrderId: expectedOrderId,
        asset: assetMapping.krakenAsset,
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

  protected async initiateWithdrawal(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    amount: string,
    assetMapping: KrakenAssetMapping,
    recipient: string,
  ): Promise<{ id: string }> {
    try {
      // Safety check: Kraken system status before withdrawal
      const isOperational = await this.client.isSystemOperational();
      if (!isOperational) {
        throw new Error('Kraken system is not operational - cannot initiate withdrawal');
      }

      this.logger.debug('Using recipient address', {
        recipient,
        route,
      });

      const withdrawOrderId = generateWithdrawOrderId(route, originTransaction.transactionHash);

      const assetConfig = findAssetByAddress(route.asset, route.origin, this.config.chains);
      if (!assetConfig) {
        throw new Error(`Unable to find asset config for asset ${route.asset} on chain ${route.origin}`);
      }
      const ticker = assetConfig.tickerHash;
      const decimals = getDecimalsFromConfig(ticker, route.origin.toString(), this.config);
      if (!decimals) {
        throw new Error(`Unable to find decimals for ticker ${ticker} on chain ${route.origin}`);
      }

      // Final quota check before withdrawal
      const quota = await checkWithdrawQuota(amount, assetMapping.krakenSymbol, decimals, this.client, this.logger);
      if (!quota.allowed) {
        throw new Error(quota.message || `Withdrawal amount exceeds limits`);
      }

      // Get withdrawal info and validate
      const withdrawInfo = await this.client.getWithdrawInfo(
        assetMapping.krakenAsset,
        recipient, // Using recipient as the withdrawal key
        formatUnits(BigInt(amount), decimals),
      );

      this.logger.debug(`Initiating Kraken withdrawal with id ${withdrawOrderId}`, {
        asset: assetMapping.krakenAsset,
        method: assetMapping.method,
        address: recipient,
        amount,
        withdrawOrderId,
        withdrawInfo,
      });

      const withdrawal = await this.client.withdraw({
        asset: assetMapping.krakenAsset,
        key: recipient,
        amount: formatUnits(BigInt(amount), decimals),
      });

      this.logger.info('Kraken withdrawal initiated', {
        withdrawalId: withdrawal.refid,
        withdrawOrderId,
        asset: assetMapping.krakenAsset,
        amount,
        recipient,
      });

      return { id: withdrawal.refid };
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

  protected handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...metadata,
    });
    throw new Error(`Failed to ${context}: ${(error as unknown as Error)?.message ?? 'Unknown error'}`);
  }
}
