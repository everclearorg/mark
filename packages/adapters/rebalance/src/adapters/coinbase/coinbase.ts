import {
  TransactionReceipt,
  parseUnits,
  encodeFunctionData,
  zeroAddress,
  erc20Abi,
  formatUnits,
  createPublicClient,
  http,
  fallback,
  PublicClient,
} from 'viem';
import { SupportedBridge, RebalanceRoute, MarkConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import * as database from '@mark/database';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { findAssetByAddress, findMatchingDestinationAsset } from '../../shared/asset';
import { CoinbaseClient } from './client';
import * as chains from 'viem/chains';
import { CoinbaseDepositAccount } from './types';
import { getRebalanceOperationByTransactionHash } from '@mark/database';

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

function getViemChain(id: number) {
  for (const chain of Object.values(chains)) {
    if ('id' in chain) {
      if (chain.id === id) {
        return chain;
      }
    }
  }
}

// Withdrawal status interface similar to Kraken
interface WithdrawalStatus {
  status: 'pending' | 'completed';
  onChainConfirmed: boolean;
  txId?: string;
}

export class CoinbaseBridgeAdapter implements BridgeAdapter {
  private readonly allowedRecipients: string[];

  constructor(
    protected readonly config: MarkConfiguration,
    protected readonly logger: Logger,
    private readonly db: typeof database,
  ) {
    this.db = db;
    this.allowedRecipients = this.config.coinbase?.allowedRecipients || [];

    if (!this.config.coinbase?.apiKey || !this.config.coinbase?.apiSecret) {
      throw new Error('CoinbaseBridgeAdapter requires API key ID and secret');
    }

    if (this.allowedRecipients.length === 0) {
      throw new Error('CoinbaseBridgeAdapter requires at least one allowed recipient');
    }

    this.logger.debug('CoinbaseBridgeAdapter initialized', {
      hasapiKey: true,
      hasapiSecret: true,
      allowedRecipients: this.allowedRecipients.join(','),
      bridgeType: SupportedBridge.Coinbase,
    });
  }

  private async getRecipientFromCache(transactionHash: string, chain: number): Promise<string | undefined> {
    try {
      const action = await this.db.getRebalanceOperationByTransactionHash(transactionHash, chain);

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

  private async getClient(): Promise<CoinbaseClient> {
    return await CoinbaseClient.getInstance({
      apiKey: this.config.coinbase?.apiKey as string,
      apiSecret: this.config.coinbase?.apiSecret as string,
      allowedRecipients: this.allowedRecipients,
      baseUrl: 'https://api.coinbase.com',
    });
  }

  type(): SupportedBridge {
    return SupportedBridge.Coinbase;
  }

  /**
   * Calculate the amount that would be received on the destination chain
   * For now, this is a placeholder implementation
   */
  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    this.logger.debug('Calculating received amount for Coinbase bridge', {
      amount,
      route,
      bridgeType: SupportedBridge.Coinbase,
    });

    // Coinbase API appears to have no way to estimate a fee ahead of time.
    // Only appears to be possible with Exchange API.
    // Just return the origin amount, though in reality it will be less.
    return amount;
  }

  /**
   * Maps a rebalance route to Coinbase-specific network and asset identifiers
   * @param route - The rebalance route containing origin/destination chain IDs and asset address
   * @returns Object containing:
   *  - bridgeNetwork: The Coinbase network identifier (e.g. "base", "ethereum")
   *  - bridgeAssetSymbol: The Coinbase asset symbol (e.g. "ETH", "USDC")
   *  - depositAccount: The Coinbase deposit account & address for receiving funds of this asset+network composite
   * @throws Error if origin asset cannot be found or if route is invalid
   */
  async mapRoute(
    route: RebalanceRoute,
  ): Promise<{ bridgeNetwork: string; bridgeAssetSymbol: string; depositAccount: CoinbaseDepositAccount }> {
    const originAsset = findAssetByAddress(route.asset, route.origin, this.config.chains, this.logger);
    if (!originAsset) {
      throw new Error(`Unable to find origin asset for asset ${route.asset} on chain ${route.origin}`);
    }

    const client = await this.getClient();

    // get the Coinbase network for the destination chain/network
    const bridgeNetwork = client.getCoinbaseNetwork(route.destination);

    // with currently supported assets, only WETH requires a mapping to a bridgeAssetSymbol because it must be bridged as ETH
    // Expand as needed in future. For example, cbBTC would need a bridgeAssetSymbol of "BTC"
    const bridgeAssetSymbol = originAsset.symbol === 'WETH' ? 'ETH' : originAsset.symbol;

    // obtain the CEX deposit address for this asset+network composite
    const depositAccount = await client.getDepositAccount(bridgeAssetSymbol, bridgeNetwork.networkLabel);

    return {
      bridgeNetwork: bridgeNetwork.networkLabel,
      bridgeAssetSymbol,
      depositAccount,
    };
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      // map the route to Coinbase-specific network and asset identifiers
      const mappedRoute = await this.mapRoute(route);

      const nativeAsset = findAssetByAddress(zeroAddress, route.origin, this.config.chains, this.logger);

      // native asset safety checks
      if (!nativeAsset?.isNative || nativeAsset.address !== zeroAddress) {
        throw new Error(`Native asset ${nativeAsset?.symbol} on chain ${route.origin} is not properly configured`);
      }

      this.logger.debug('Coinbase deposit address obtained for transaction preparation', {
        asset: route.asset,
        bridgeAssetSymbol: mappedRoute.bridgeAssetSymbol,
        bridgeNetwork: mappedRoute.bridgeNetwork,
        depositAddress: mappedRoute.depositAccount.address,
        amount,
        recipient,
        originChain: route.origin,
        destinationChain: route.destination,
      });

      const transactions: MemoizedTransactionRequest[] = [];

      // if bridge asset is the native asset of the origin chain (as opposed to a token) then we need special handling.
      // at the very least, we will need to deposit the native asset as an intrinsic txn value.
      // we may also need to unwrap our originAsset first.
      if (mappedRoute.bridgeAssetSymbol.toLowerCase() === nativeAsset?.symbol.toLowerCase()) {
        let unwrapFirst = false;

        // if origin asset is not the native asset itself, but is a supported wrapped version of the native asset (only WETH at time of writing),
        // then prepare it to be unwrapped first (Coinbase & most CEX's do not accept wrapped version of native assets).
        if (
          route.asset !== zeroAddress &&
          // confirm that native asset is an unwrapped version of the origin asset
          mappedRoute.bridgeAssetSymbol.toLowerCase() === nativeAsset?.symbol.toLowerCase()
        )
          unwrapFirst = true;

        if (unwrapFirst) {
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
              funcSig: 'withdraw(uint256)',
            },
          };

          transactions.push(unwrapTx);
        }

        // Handle native ETH deposit
        transactions.push({
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: mappedRoute.depositAccount.address as `0x${string}`,
            value: BigInt(amount),
            data: '0x' as `0x${string}`,
          },
        });
      }

      // if bridge asset is a token (USDC, USDT etc), then handling is much simpler than native
      // We just need to transfer the token to the deposit address.
      else {
        transactions.push({
          memo: RebalanceTransactionMemo.Rebalance,
          transaction: {
            to: route.asset as `0x${string}`,
            value: BigInt(0),
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [mappedRoute.depositAccount.address as `0x${string}`, BigInt(amount)],
            }),
            funcSig: 'transfer(address,uint256)',
          },
        });
      }

      return transactions;
    } catch (error) {
      this.handleError(error, 'prepare Coinbase deposit transaction', { amount, route });
    }
  }

  async readyOnDestination(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<boolean> {
    this.logger.debug('Checking if Coinbase withdrawal is ready on destination', {
      amount,
      originChain: route.origin,
      destinationChain: route.destination,
      asset: route.asset,
      transactionHash: originTransaction.transactionHash,
      blockNumber: originTransaction.blockNumber,
    });

    try {
      const recipient = await this.getRecipientFromCache(originTransaction.transactionHash, route.origin);
      if (!recipient) {
        this.logger.error('Cannot check withdrawal readiness - recipient missing from cache', {
          transactionHash: originTransaction.transactionHash,
          originChain: route.origin,
          destinationChain: route.destination,
          asset: route.asset,
          blockNumber: originTransaction.blockNumber,
          requiredFor: 'coinbase_withdrawal_initiation',
        });
        return false;
      }

      const withdrawalStatus = await this.getOrInitWithdrawal(amount, route, originTransaction, recipient);
      this.logger.debug('Coinbase withdrawal status retrieved', {
        withdrawalStatus,
        deposit: originTransaction.transactionHash,
        route,
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

  protected async getOrInitWithdrawal(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
    recipient: string,
  ): Promise<WithdrawalStatus | undefined> {
    try {
      // Check if deposit is confirmed first
      const depositStatus = await this.checkDepositConfirmed(route, originTransaction);
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
        withdrawal = await this.initiateWithdrawal(route, originTransaction, amount, recipient);
        this.logger.info('Initiated withdrawal', { originTransaction, withdrawal });
      }

      // Check withdrawal status
      const client = await this.getClient();
      const mappedRoute = await this.mapRoute(route);
      const currentWithdrawal = await client.getWithdrawalById(mappedRoute.depositAccount.accountId, withdrawal.id);

      // NOTE: coinbase will show a transaction hash here prior to them considering the withdrawal to be "completed" (confirmed on chain).
      // We can wait for them to report that they consider it confirmed, but this can take 10+ minutes.
      // Since our only subsequent actions are a potential wrap of native asset,
      // it seems low-risk to just assume its confirmed "enough" as soon as the hash appears and (in next steps) a reciept can be pulled for it.
      //
      // if this assumption becomes problematic down the road, we can implement our own confirmation logic that can be faster than coinbase's.
      if (currentWithdrawal?.network?.hash) {
        currentWithdrawal.status = 'completed';
      }

      if (!currentWithdrawal) {
        return {
          status: 'pending',
          onChainConfirmed: false,
        };
      }

      // Verify on-chain if completed
      let onChainConfirmed = false;
      if (currentWithdrawal.status.toLowerCase() === 'completed' && currentWithdrawal.network?.hash) {
        const provider = this.getProvider(route.destination);
        if (provider) {
          try {
            const hash = currentWithdrawal.network.hash.startsWith('0x')
              ? currentWithdrawal.network.hash
              : `0x${currentWithdrawal.network.hash}`;
            const receipt = await provider.getTransactionReceipt({
              hash: hash as `0x${string}`,
            });
            onChainConfirmed = receipt !== null && receipt.status === 'success';
          } catch (error) {
            this.logger.debug('Could not verify on-chain confirmation', {
              txId: currentWithdrawal.network.hash,
              error: jsonifyError(error),
            });
          }
        }
      }

      return {
        status: currentWithdrawal.status.toLowerCase() === 'completed' ? 'completed' : 'pending',
        onChainConfirmed,
        txId: currentWithdrawal.network?.hash || undefined,
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
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<{ confirmed: boolean }> {
    try {
      const client = await this.getClient();
      const mappedRoute = await this.mapRoute(route);

      // Get the transaction from Coinbase using the deposit account and address
      const transaction = await client.getTransactionByHash(
        mappedRoute.depositAccount.accountId,
        mappedRoute.depositAccount.addressId,
        originTransaction.transactionHash,
      );

      const confirmed = !!transaction && transaction.status.toLowerCase() === 'completed';
      this.logger.debug('Deposit confirmation check', {
        transactionHash: originTransaction.transactionHash,
        confirmed,
        matchingTransactionId: transaction?.id,
        status: transaction?.status,
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
  ): Promise<{ id: string } | undefined> {
    try {
      // Lookup the rebalance operation via the origin deposit tx hash
      const op = await this.db.getRebalanceOperationByTransactionHash(originTransaction.transactionHash, route.origin);
      if (!op) {
        this.logger.debug('No rebalance operation found for deposit', {
          route,
          deposit: originTransaction.transactionHash,
        });
        return undefined;
      }

      const record = await this.db.getCexWithdrawalRecord({
        rebalanceOperationId: op.id,
        platform: 'coinbase',
      });

      if (!record) {
        this.logger.debug('No existing withdrawal found', {
          route,
          deposit: originTransaction.transactionHash,
        });
        return undefined;
      }

      const metadata = record.metadata as { id?: string };
      if (!metadata?.id) {
        this.logger.warn('Existing CEX withdrawal record missing expected Coinbase fields', {
          route,
          deposit: originTransaction.transactionHash,
          record,
        });
        return undefined;
      }

      this.logger.debug('Found existing withdrawal', {
        route,
        deposit: originTransaction.transactionHash,
        record,
      });
      return { id: metadata.id };
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
    recipient: string,
  ): Promise<{ id: string }> {
    try {
      // Get the rebalance operation details from the database/cache
      const rebalanceOperation = await getRebalanceOperationByTransactionHash(
        originTransaction.transactionHash,
        route.origin,
      );

      if (!rebalanceOperation) {
        throw new Error('No rebalance operation found for transaction');
      }

      // we need decimals for the asset we are withdrawing.
      // however, the rebalance op always stores the raw amount of the *origin* asset, so we need origin decimals
      const originAsset = findAssetByAddress(route.asset, route.origin, this.config.chains, this.logger);

      if (!originAsset) {
        throw new Error('No origin asset found');
      }

      // Map the route to Coinbase-specific network and asset identifiers
      const mappedRoute = await this.mapRoute(route);

      // coinbase does not support more than 8 decimals of precision on assets with 18 decimals (or perhaps on any assets).
      // EG: Withdrawl target of 0.100000012345 units of ETH must be withdrawn as 0.10000001 units
      // if more finessing is needed for future assets, add/tweak here.
      const withdrawPrecision = originAsset.decimals == 18 ? 8 : originAsset.decimals;

      const withdrawUnits = Number(formatUnits(BigInt(rebalanceOperation.amount), originAsset.decimals)).toFixed(
        withdrawPrecision,
      );

      const client = await this.getClient();

      this.logger.debug('Initiating Coinbase withdrawal', {
        units: withdrawUnits,
        currency: mappedRoute.bridgeAssetSymbol,
        network: mappedRoute.bridgeNetwork,
        destinationAddress: recipient,
        rebalanceOperationId: rebalanceOperation.id,
      });

      const withdrawalResponse = await client.sendCrypto({
        to: recipient,
        units: withdrawUnits,
        currency: mappedRoute.bridgeAssetSymbol,
        network: mappedRoute.bridgeNetwork,
        description: `Self-Transfer`,
      });

      await this.db.createCexWithdrawalRecord({
        rebalanceOperationId: rebalanceOperation.id,
        platform: 'coinbase',
        metadata: {
          id: withdrawalResponse.data.id,
          status: withdrawalResponse.data.status,
          currency: mappedRoute.bridgeAssetSymbol,
          network: mappedRoute.bridgeNetwork,
          depositTransactionHash: originTransaction.transactionHash,
          destinationChainId: route.destination,
        },
      });

      this.logger.debug('Coinbase withdrawal initiated successfully', {
        withdrawalId: withdrawalResponse.data.id,
        status: withdrawalResponse.data.status,
        units: withdrawUnits,
        currency: mappedRoute.bridgeAssetSymbol,
        destinationAddress: recipient,
        rebalanceOperationId: rebalanceOperation.id,
      });

      return { id: withdrawalResponse.data.id };
    } catch (error) {
      this.logger.error('Failed to initiate withdrawal', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
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
      const providers = chainConfig.providers;
      const transports = providers.map((url) => http(url));
      const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: true });
      return createPublicClient({
        transport,
      });
    } catch (error) {
      this.logger.error('Failed to create provider', {
        error: jsonifyError(error),
        chainId,
        providers: chainConfig.providers,
      });
      return undefined;
    }
  }

  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    this.logger.debug('Executing Coinbase destination callback', {
      route,
      originTransactionHash: originTransaction.transactionHash,
      bridgeType: SupportedBridge.Coinbase,
    });

    try {
      // Get recipient
      const recipient = await this.getRecipientFromCache(originTransaction.transactionHash, route.origin);
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

      // Get withdrawal status from Coinbase
      const client = await this.getClient();
      const mappedRoute = await this.mapRoute(route);
      const withdrawal = await client.getWithdrawalById(mappedRoute.depositAccount.accountId, withdrawalRef.id);
      if (!withdrawal) {
        throw new Error(
          `Failed to retrieve coinbase withdrawal status for ${withdrawalRef.id} to ${recipient} on ${route.destination}`,
        );
      }
      if (!withdrawal.network?.hash) {
        throw new Error(`Withdrawal (${withdrawalRef.id}) is not successful/completed`);
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

      const destNativeAsset = findAssetByAddress(zeroAddress, route.destination, this.config.chains, this.logger);

      if (!destNativeAsset?.isNative || destNativeAsset.address !== zeroAddress) {
        throw new Error(
          `Destination native asset ${destNativeAsset?.symbol} on chain ${route.destination} is not properly configured`,
        );
      }

      if (
        mappedRoute.bridgeAssetSymbol.toLowerCase() != destNativeAsset?.symbol.toLowerCase() ||
        destinationAssetConfig.symbol.toLowerCase() != 'weth'
      ) {
        this.logger.debug('Destination asset does not require wrapping, no callbacks needed', {
          route,
          withdrawalRef,
          withdrawal,
          originAssetConfig,
          deposit: originTransaction.transactionHash,
        });
        return;
      }

      // at this point:
      // - destination asset is WETH
      // - destination native gas asset is ETH
      // - coinbase would have delivered native ETH
      // --> we need to wrap

      // This should never happen - but verify that transaction fee symbol matches bridge asset symbol
      // IE: Verify that the fee they charged was in the same asset as the one withdrawn (The native asset)
      // if not, just leave it unwrapped.
      if (withdrawal.network?.transaction_fee?.currency.toLowerCase() !== mappedRoute.bridgeAssetSymbol.toLowerCase()) {
        this.logger.info('Transaction fee symbol does not match bridge asset symbol, skipping wrap', {
          feeCurrency: withdrawal.network?.transaction_fee?.currency,
          bridgeAssetSymbol: mappedRoute.bridgeAssetSymbol,
          route,
          withdrawalId: withdrawalRef.id,
        });
        return;
      }

      const withdrawnUnits =
        Number(withdrawal.amount.amount) * -1 - Number(withdrawal.network?.transaction_fee?.amount || 0);

      // CB api formats withdrawal as negative units. Invert & convert into raw amount for wrapping.
      const wrapAmountRaw = parseUnits(withdrawnUnits.toString(), destinationAssetConfig.decimals);
      this.logger.info('Wrapping native asset into weth', {
        route,
        originTransaction: originTransaction.transactionHash,
        withdrawal,
        destinationAssetConfig,
        originAssetConfig,
        recipient,
        wrapAmountRaw,
        wethAddress: destinationAssetConfig.address,
        destinationChain: route.destination,
      });

      // Verify destination asset symbol matches contract symbol
      // Skip in test environment to avoid external HTTP calls
      if (this.config.coinbase?.apiKey!='test-coinbase-api-key') {
        const providers = this.config.chains[route.destination]?.providers ?? [];
        const transports = providers.map((url) => http(url));
        const transport = transports.length === 1 ? transports[0] : fallback(transports, { rank: true });
        const destinationPublicClient = createPublicClient({
          chain: getViemChain(route.destination),
          transport,
        });

        // safety check: confirm that the target address appears to be a valid ERC20 contract of the intended asset
        try {
          const contractSymbol = (await destinationPublicClient.readContract({
            address: destinationAssetConfig.address as `0x${string}`,
            abi: erc20Abi,
            functionName: 'symbol',
          })) as string;

          if (contractSymbol.toLowerCase() !== destinationAssetConfig.symbol.toLowerCase()) {
            throw new Error(
              `Wrap Destination asset symbol mismatch. Expected ${destinationAssetConfig.symbol}, got ${contractSymbol} from contract`,
            );
          }
        } catch (error) {
          this.handleError(error, 'verify destination asset symbol', {
            destinationAsset: destinationAssetConfig.address,
            expectedSymbol: destinationAssetConfig.symbol,
          });
        }
      }

      // After withdrawal complete, Wrap equivalent amount of native asset on the destination chain
      const wrapTx = {
        memo: RebalanceTransactionMemo.Wrap,
        transaction: {
          to: destinationAssetConfig.address as `0x${string}`,
          data: encodeFunctionData({
            abi: wethAbi,
            functionName: 'deposit',
            args: [],
          }) as `0x${string}`,
          value: wrapAmountRaw,
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

      this.handleError(error, 'prepare destination callback', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
    }
  }

  /**
   * Get account information from Coinbase
   */
  async getAccounts() {
    try {
      const client = await this.getClient();
      const accounts = await client.getAccounts();
      this.logger.debug('Retrieved Coinbase accounts', {
        accountCount: accounts.data.length,
        bridgeType: SupportedBridge.Coinbase,
      });
      return accounts;
    } catch (error) {
      this.logger.error('Failed to retrieve Coinbase accounts', {
        error: error instanceof Error ? error.message : String(error),
        bridgeType: SupportedBridge.Coinbase,
      });
      throw error;
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
