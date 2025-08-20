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
import { SupportedBridge, RebalanceRoute, MarkConfiguration, AssetConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { RebalanceCache } from '@mark/cache';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { KrakenClient } from './client';
import { DynamicAssetConfig } from './dynamic-config';
import { WithdrawalStatus, KrakenAssetMapping, KRAKEN_WITHDRAWAL_STATUS, KRAKEN_DEPOSIT_STATUS } from './types';
import { getValidAssetMapping, getDestinationAssetMapping } from './utils';
import { findAssetByAddress, findMatchingDestinationAsset } from '../../shared/asset';

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
      const { received, originMapping, destinationMapping } = await this.validateRebalanceRequest(
        BigInt(amount),
        route,
      );

      this.logger.debug('Kraken withdrawal amount calculated after fees', {
        amount,
        received,
        route,
        depositMethod: originMapping.depositMethod,
        withdrawMethod: destinationMapping.withdrawMethod,
      });

      return received.toString();
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
      const { originMapping } = await this.validateRebalanceRequest(BigInt(amount), route);

      // Get deposit address
      const depositAddresses = await this.client.getDepositAddresses(
        originMapping.krakenAsset,
        originMapping.depositMethod.method,
      );
      if (!depositAddresses || depositAddresses.length === 0) {
        throw new Error(
          `No deposit address available for ${originMapping.krakenAsset} on ${originMapping.depositMethod}`,
        );
      }
      const depositAddress = depositAddresses[0].address;

      this.logger.debug('Kraken deposit address obtained for transaction preparation', {
        asset: originMapping.krakenAsset,
        krakenSymbol: originMapping.krakenSymbol,
        depositMethod: originMapping.depositMethod,
        depositAddress,
        amount,
        recipient,
        originChain: route.origin,
        destinationChain: route.destination,
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

      const originMapping = await getValidAssetMapping(this.dynamicConfig, route, `route from chain ${route.origin}`);
      const { destinationAssetConfig, destinationMapping, received } = await this.validateDestinationWithdrawal(
        BigInt(amount),
        route,
        originMapping,
      );

      const withdrawalStatus = await this.getOrInitWithdrawal(
        amount,
        route,
        originTransaction,
        recipient,
        originMapping,
        destinationMapping,
        destinationAssetConfig,
      );
      this.logger.debug('Kraken withdrawal status retrieved', {
        withdrawalStatus,
        deposit: originTransaction.transactionHash,
        route,
        expectedReceived: received,
        transactionHash: originTransaction.transactionHash,
        recipient,
      });

      if (!withdrawalStatus) {
        return false;
      }

      const isReady = withdrawalStatus.status === 'completed' && withdrawalStatus.onChainConfirmed;

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
      // Get recipient
      const recipient = await this.getRecipientFromCache(originTransaction.transactionHash);
      if (!recipient) {
        this.logger.error('No recipient found in cache for callback', {
          transactionHash: originTransaction.transactionHash,
        });
        return;
      }

      // Get withdrawal record
      const withdrawalRef = await this.findExistingWithdrawal(route, originTransaction);
      if (!withdrawalRef) {
        this.logger.error('No withdrawal found to execute callbacks for', { route, originTransaction });
        return;
      }
      this.logger.debug('Retrieved existing withdrawal', {
        withdrawalRef,
        deposit: originTransaction.transactionHash,
        route,
      });

      // Verify withdrawal status
      const status = await this.client.getWithdrawStatus(
        withdrawalRef.asset,
        withdrawalRef.method,
        withdrawalRef.refid,
      );
      if (!status) {
        throw new Error(
          `Failed to retrieve kraken withdrawal status for ${withdrawalRef} to ${recipient} on ${route.destination}`,
        );
      }
      if (status.status.toLowerCase() !== 'success') {
        throw new Error(`Withdrawal (${withdrawalRef}) is not successful, status: ${status.status}`);
      }

      // The only destination callback is handling the wrapping of the native asset.
      // You must wrap the native asset iff:
      // - origin asset was weth by route, eth by kraken
      // - withdrawal received eth
      // - destination supports native eth

      // if the method includes erc20 on the withdrawal, no wrapping needed
      if (status.method.toLowerCase().includes('erc-20')) {
        this.logger.info('Withdraw method was erc20, no need to wrap', {
          status,
          route,
        });
        return;
      }

      // get origin asset config
      const originAssetConfig = findAssetByAddress(route.asset, route.origin, this.config.chains, this.logger);
      if (!originAssetConfig) {
        throw new Error(
          `No origin asset config detected for route(origin=${route.origin},destination=${route.destination},asset=${route.asset})`,
        );
      }
      const destinationAssetConfig = findMatchingDestinationAsset(
        route.asset,
        route.origin,
        route.destination,
        this.config.chains,
        this.logger,
      );
      if (!destinationAssetConfig) {
        throw new Error(
          `No destination asset config detected for route(origin=${route.origin},destination=${route.destination},asset=${route.asset})`,
        );
      }
      if (originAssetConfig.symbol.toLowerCase() !== 'weth' && originAssetConfig.symbol.toLowerCase() !== 'eth') {
        this.logger.debug('Origin asset is not weth, no callbacks needed on kraken', {
          route,
          withdrawalRef,
          status,
          originAssetConfig,
          deposit: originTransaction.transactionHash,
        });
        return;
      }

      if (destinationAssetConfig.symbol.toLowerCase() !== 'weth') {
        this.logger.debug('Destination asset is not weth, no callbacks needed on kraken', {
          route,
          withdrawalRef,
          status,
          originAssetConfig,
          deposit: originTransaction.transactionHash,
        });
        return;
      }

      // at this point:
      // - origin asset is WETH or ETH
      // - destination asset is WETH
      // - kraken delivered without erc20
      // --> we need to wrap
      const toWrap = parseUnits(status.amount, 18);
      this.logger.info('Wrapping native asset into weth', {
        route,
        originTransaction: originTransaction.transactionHash,
        status,
        destinationAssetConfig,
        originAssetConfig,
      });
      const provider = this.getProvider(route.destination);
      if (!provider) {
        this.logger.error('No provider for destination chain', { chainId: route.destination });
        return;
      }

      this.logger.info('Preparing WETH wrap callback', {
        recipient,
        toWrap,
        wethAddress: destinationAssetConfig.address,
        destinationChain: route.destination,
      });

      // Wrap ETH to WETH on the destination chain after withdrawal if needed
      const wrapTx = {
        memo: RebalanceTransactionMemo.Wrap,
        transaction: {
          to: destinationAssetConfig.address as `0x${string}`,
          data: encodeFunctionData({
            abi: wethAbi,
            functionName: 'deposit',
            args: [],
          }) as `0x${string}`,
          value: toWrap,
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

  protected async validateRebalanceRequest(
    amount: bigint,
    route: RebalanceRoute,
  ): Promise<{
    originMapping: KrakenAssetMapping;
    destinationMapping: KrakenAssetMapping;
    received: bigint;
    originAssetConfig: AssetConfiguration;
    destinationAssetConfig: AssetConfiguration;
  }> {
    // safety check: kraken system status
    const isOperational = await this.client.isSystemOperational();
    if (!isOperational) {
      throw new Error('Kraken system is not operational');
    }

    // safety check: ensure asset is configured properly
    const originAssetConfig = findAssetByAddress(route.asset, route.origin, this.config.chains, this.logger);
    if (!originAssetConfig) {
      throw new Error(`Unable to find origin asset config for asset ${route.asset} on chain ${route.origin}`);
    }

    // safety check: ensure asset is supported on Kraken
    const originMapping = await getValidAssetMapping(this.dynamicConfig, route, `route from chain ${route.origin}`);
    if (!originMapping) {
      throw new Error(`Unable to find origin mappings for rebalance route`);
    }

    // safety check: oriigin asset is not disabled on kraken
    const assetInfo = await this.client.getAssetInfo([originMapping.krakenAsset]);
    if (!assetInfo[originMapping.krakenAsset]) {
      throw new Error(`Unable to find kraken asset status for origin asset`);
    }
    if (assetInfo[originMapping.krakenAsset].status === 'disabled') {
      throw new Error(`Origin asset is disabled on Kraken`);
    }

    // safety check: amount is above the deposit minimum
    const depositMin = parseUnits(originMapping.depositMethod.minimum, originAssetConfig.decimals);
    if (depositMin < amount) {
      throw new Error(`Deposit amount ${amount} is below the minimum ${depositMin}`);
    }

    // safety check: deposit method limit
    if (originMapping.depositMethod.limit) {
      throw new Error(`Deposit method is limited`);
    }

    // safety check: withdrawals
    const { received, destinationAssetConfig, destinationMapping } = await this.validateDestinationWithdrawal(
      amount,
      route,
      originMapping,
      isOperational,
    );

    return {
      originAssetConfig: originAssetConfig!,
      destinationAssetConfig,
      originMapping,
      destinationMapping,
      received,
    };
  }

  protected async validateDestinationWithdrawal(
    amount: bigint,
    route: RebalanceRoute,
    originMapping: KrakenAssetMapping,
    _isOperational?: boolean,
  ): Promise<{ received: bigint; destinationAssetConfig: AssetConfiguration; destinationMapping: KrakenAssetMapping }> {
    // safety check: kraken system status
    const isOperational = _isOperational ?? (await this.client.isSystemOperational());
    if (!isOperational) {
      throw new Error('Kraken system is not operational');
    }

    // safety check: asset configured on destination
    const destinationAssetConfig = findMatchingDestinationAsset(
      route.asset,
      route.origin,
      route.destination,
      this.config.chains,
      this.logger,
    );
    if (!destinationAssetConfig) {
      throw new Error(
        `Unable to find destination asset config for asset (${route.asset}, ${route.origin}) on chain ${route.destination}`,
      );
    }

    const destinationMapping = await getDestinationAssetMapping(this.dynamicConfig, route, originMapping);
    if (!destinationMapping) {
      throw new Error(`Unable to find destination mappings for rebalance route`);
    }

    // safety check: destination asset is not disabled on kraken
    const assetInfo = await this.client.getAssetInfo([destinationMapping.krakenAsset]);
    if (!assetInfo[destinationMapping.krakenAsset]) {
      throw new Error(`Unable to find kraken asset status for destination asset`);
    }
    if (assetInfo[destinationMapping.krakenAsset].status === 'disabled') {
      throw new Error(`Destination asset is disabled on Kraken`);
    }

    // safety check: amount less fees is above the withdraw minimum
    const received = amount - parseUnits(destinationMapping.withdrawMethod.fee.fee, destinationAssetConfig.decimals);
    const min = parseUnits(destinationMapping.withdrawMethod.minimum, destinationAssetConfig.decimals);
    if (received < min) {
      throw new Error(`Received amount is below the withdrawal minimum`);
    }

    // safety check: amount less fees is below the withdraw daily limits
    const dailies = destinationMapping.withdrawMethod.limits.find((l) => l.limit_type === 'amount')!.limits['86400'];
    const limit = parseUnits(dailies.remaining, destinationAssetConfig.decimals);
    if (received > limit) {
      throw new Error(`Received amount (${received}) exceeds withdraw limits (${limit})`);
    }

    return { received, destinationAssetConfig: destinationAssetConfig!, destinationMapping };
  }

  protected async getOrInitWithdrawal(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    recipient: string,
    originMapping: KrakenAssetMapping,
    destinationMapping: KrakenAssetMapping,
    destinationAssetConfig: AssetConfiguration,
  ): Promise<WithdrawalStatus | undefined> {
    try {
      // Check if deposit is confirmed first
      const depositStatus = await this.checkDepositConfirmed(route, originTransaction, originMapping);
      this.logger.debug('Got deposit status', {
        transactionHash: originTransaction.transactionHash,
        depositStatus,
      });
      if (!depositStatus.confirmed) {
        this.logger.debug('Deposit not yet confirmed', {
          transactionHash: originTransaction.transactionHash,
        });
        return undefined;
      }

      // Check if withdrawal exists, if not initiate it
      let withdrawal = await this.findExistingWithdrawal(route, originTransaction);
      if (!withdrawal) {
        this.logger.debug('No withdrawal detected, submitting another', {
          originTransaction,
        });
        withdrawal = await this.initiateWithdrawal(
          route,
          originTransaction,
          amount,
          destinationMapping,
          destinationAssetConfig,
          recipient,
        );
        this.logger.info('Initiated withdrawal', { originTransaction, withdrawal });
      }

      // Check withdrawal status
      const currentWithdrawal = await this.client.getWithdrawStatus(
        withdrawal.asset,
        withdrawal.method,
        withdrawal.refid,
      );

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
      const deposits = await this.client.getDepositStatus(assetMapping.krakenAsset, assetMapping.depositMethod.method);

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
  ): Promise<{ refid: string; asset: string; method: string } | undefined> {
    try {
      const existingWithdrawal = await this.rebalanceCache.getWithdrawalRecord(originTransaction.transactionHash);
      if (!existingWithdrawal) {
        this.logger.debug('No existing withdrawal found', {
          route,
          deposit: originTransaction.transactionHash,
        });
        return undefined;
      }
      this.logger.debug('Found existing withdrawal', {
        route,
        deposit: originTransaction.transactionHash,
        existingWithdrawal,
      });
      return existingWithdrawal;
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
    assetConfig: AssetConfiguration,
    recipient: string,
  ): Promise<{ refid: string; asset: string; method: string }> {
    try {
      this.logger.debug(`Initiating Kraken withdrawal`, {
        asset: assetMapping.krakenAsset,
        method: assetMapping.withdrawMethod.method,
        recipient,
        route,
        amount,
      });

      const withdrawal = await this.client.withdraw({
        asset: assetMapping.krakenAsset,
        key: recipient,
        amount: formatUnits(BigInt(amount), assetConfig.decimals),
      });

      this.logger.info('Kraken withdrawal initiated', {
        withdrawal,
        asset: assetMapping.krakenAsset,
        amount,
        recipient,
      });

      await this.rebalanceCache.addWithdrawalRecord(
        originTransaction.transactionHash,
        assetMapping.krakenAsset,
        assetMapping.withdrawMethod.method,
        withdrawal.refid,
      );

      this.logger.debug('Kraken withdrawal saved to cache', {
        withdrawal,
        asset: assetMapping.krakenAsset,
        amount,
        recipient,
      });

      return { refid: withdrawal.refid, asset: assetMapping.krakenAsset, method: assetMapping.withdrawMethod.method };
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
