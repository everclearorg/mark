import {
  TransactionReceipt,
  TransactionRequestBase,
  createPublicClient,
  encodeFunctionData,
  http,
  zeroAddress,
  erc20Abi,
  PublicClient,
  padHex,
  fallback,
} from 'viem';
import { ChainConfiguration, SupportedBridge, RebalanceRoute, axiosGet } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, MemoizedTransactionRequest, RebalanceTransactionMemo } from '../../types';
import { SuggestedFeesResponse, DepositStatusResponse, WETH_WITHDRAWAL_TOPIC } from './types';
import { parseFillLogs, getDepositFromLogs } from './utils';
import { ACROSS_SPOKE_ABI } from './abi';
import { findAssetByAddress, findMatchingDestinationAsset } from '../../shared/asset';

// Structure to hold callback info
interface CallbackInfo {
  needsCallback: boolean;
  amount?: bigint;
  recipient?: string;
}

export class AcrossBridgeAdapter implements BridgeAdapter {
  constructor(
    protected readonly url: string,
    protected readonly chains: Record<string, ChainConfiguration>,
    protected readonly logger: Logger,
  ) {
    this.logger.debug('Initializing AcrossBridgeAdapter', { url });
  }

  type(): SupportedBridge {
    return SupportedBridge.Across;
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      const feesData = await this.getSuggestedFees(route, amount);

      if (feesData.isAmountTooLow) {
        throw new Error('Amount is too low for suggested route via across');
      }

      return feesData.outputAmount.toString();
    } catch (error) {
      this.handleError(error, 'get received amount from Across', { amount, route });
    }
  }

  async send(
    sender: string,
    recipient: string,
    amount: string,
    route: RebalanceRoute,
  ): Promise<MemoizedTransactionRequest[]> {
    try {
      const feesData = await this.getSuggestedFees(route, amount);

      if (feesData.isAmountTooLow) {
        throw new Error('Amount is too low for bridging via Across');
      }

      const outputToken = findMatchingDestinationAsset(
        route.asset,
        route.origin,
        route.destination,
        this.chains,
        this.logger,
        route.destinationAsset,
      );
      if (!outputToken) {
        throw new Error('Could not find matching destination asset');
      }

      let approvalTx: MemoizedTransactionRequest | undefined;

      // Get the approval transaction if required
      if (route.asset.toLowerCase() !== zeroAddress.toLowerCase()) {
        const providers = this.chains[route.origin.toString()]?.providers ?? [];
        if (!providers.length) {
          throw new Error(`No providers found for origin chain ${route.origin}`);
        }
        const client = createPublicClient({ transport: fallback(providers.map((p: string) => http(p))) });
        const allowance = await client.readContract({
          address: route.asset as `0x${string}`,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [sender as `0x${string}`, feesData.spokePoolAddress as `0x${string}`],
        });

        if (allowance < BigInt(amount)) {
          approvalTx = {
            memo: RebalanceTransactionMemo.Approval,
            transaction: {
              to: route.asset as `0x${string}`,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'approve',
                args: [feesData.spokePoolAddress as `0x${string}`, BigInt(amount)],
              }),
              value: BigInt(0),
              funcSig: 'approve(address,uint256)',
            },
          };
        }
      }

      const bridgeTx: MemoizedTransactionRequest = {
        memo: RebalanceTransactionMemo.Rebalance,
        transaction: {
          to: feesData.spokePoolAddress,
          data: encodeFunctionData({
            abi: ACROSS_SPOKE_ABI,
            functionName: 'depositV3',
            args: [
              sender, // depositor
              recipient, // recipient
              route.asset, // inputToken
              outputToken.address, // outputToken
              BigInt(amount), // inputAmount
              feesData.outputAmount, // outputAmount
              BigInt(route.destination), // destinationChainId
              zeroAddress, // exclusiveRelayer - must be ZeroAddress per Zodiac permissions
              feesData.timestamp, // quoteTimestamp
              feesData.fillDeadline, // fillDeadline
              BigInt(0), // exclusivityDeadline - must be 0 per Zodiac permissions
              '0x', // message - must be "0x" per Zodiac permissions
            ],
          }),
          value: route.asset === zeroAddress ? BigInt(amount) : BigInt(0),
          funcSig:
            'depositV3(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint256,uint256,uint256,bytes)',
        },
      };

      return [approvalTx, bridgeTx].filter((x) => !!x);
    } catch (error) {
      this.handleError(error, 'prepare Across bridge transaction', { amount, route });
    }
  }

  async destinationCallback(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<MemoizedTransactionRequest | void> {
    try {
      const statusData = await this.getDepositStatus(route, originTransaction);
      if (!statusData || statusData.status !== 'filled' || !statusData.fillTx) {
        throw new Error(`Transaction (depositId: ${statusData?.depositId}) is not yet filled`);
      }

      const callbackInfo = await this.requiresCallback(route, statusData.fillTx);
      if (!callbackInfo.needsCallback) {
        return;
      }

      const originAsset = findAssetByAddress(route.asset, route.origin, this.chains, this.logger);
      if (!originAsset) {
        throw new Error('Could not find origin asset');
      }

      // Only WETH transfers need wrapping callbacks
      if (originAsset.symbol.toLowerCase() !== 'weth') {
        this.logger.debug('Asset is not WETH, no callback needed', { route, originAsset });
        return;
      }

      this.logger.debug('Found WETH origin asset', { route, originAsset });
      const destinationWETH = findMatchingDestinationAsset(
        route.asset,
        route.origin,
        route.destination,
        this.chains,
        this.logger,
        route.destinationAsset,
      );
      if (!destinationWETH) {
        throw new Error('Failed to find destination WETH');
      }

      const callbackTx: TransactionRequestBase & { funcSig: string } = {
        to: destinationWETH.address as `0x${string}`,
        data: '0xd0e30db0' as `0x${string}`, // deposit() function selector
        value: callbackInfo.amount!,
        funcSig: 'deposit()',
      };

      this.logger.debug('Destination callback transaction prepared', {
        callbackTx,
        fillTxHash: statusData.fillTx,
        originTxHash: originTransaction.transactionHash,
      });

      return { transaction: callbackTx, memo: RebalanceTransactionMemo.Wrap };
    } catch (error) {
      this.logger.error('destinationCallback failed', {
        error: jsonifyError(error),
        route,
        originTxHash: originTransaction.transactionHash,
        originChain: route.origin,
        destinationChain: route.destination,
        errorMessage: (error as Error)?.message,
        errorStack: (error as Error)?.stack,
      });

      this.handleError(error, 'prepare destination callback', {
        route,
        transactionHash: originTransaction.transactionHash,
        originChain: route.origin,
        destinationChain: route.destination,
      });
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
      // Get deposit status from shared helper method
      const statusData = await this.getDepositStatus(route, originTransaction);

      // If no status found, return false
      if (!statusData) {
        return false;
      }

      // Return true if the deposit is filled
      const isReady = statusData.status === 'filled';
      this.logger.debug('Deposit ready status determined', {
        isReady,
        statusData,
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

  /**
   * Helper method to get deposit status from the Across API
   * @param route The rebalance route
   * @param originTransaction The original transaction receipt
   * @returns The deposit status response with depositId or null if no deposit ID found
   */
  protected async getDepositStatus(
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<DepositStatusResponse | undefined> {
    try {
      // Extract deposit ID from the transaction receipt
      const depositId = this.extractDepositId(route.origin, originTransaction);

      if (!depositId) {
        this.logger.warn('No deposit ID found in transaction receipt', {
          transactionHash: originTransaction.transactionHash,
        });
        return undefined;
      }

      this.logger.debug('Extracted deposit ID from transaction receipt', {
        depositId,
        transactionHash: originTransaction.transactionHash,
      });

      // Check deposit status
      this.logger.debug('Checking deposit status via Across API', {
        originChainId: route.origin,
        depositId,
      });

      const statusData = await this.getDepositStatusFromApi(route, depositId);

      this.logger.debug('Received deposit status from Across API', {
        statusData,
      });

      // Return status data with depositId attached
      return statusData;
    } catch (error) {
      this.logger.error('Failed to get deposit status', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
      throw error;
    }
  }

  // Helper methods to extract data from transaction receipt
  protected extractDepositId(origin: number, receipt: TransactionReceipt): number | undefined {
    this.logger.debug('Extracting deposit ID from transaction receipt', {
      transactionHash: receipt.transactionHash,
      logsCount: receipt.logs.length,
    });

    try {
      const logs = getDepositFromLogs({ originChainId: origin, receipt });

      return +logs.depositId.toString();
    } catch (error) {
      this.logger.error('Error extracting deposit ID from receipt', {
        error: jsonifyError(error),
        transactionHash: receipt.transactionHash,
      });

      return undefined;
    }
  }

  /**
   * Determines if a callback is needed for a transaction and returns relevant information
   * @param route The rebalance route
   * @param fillTxHash The hash of the fill transaction
   * @returns Object with needsCallback flag and fill information if available
   */
  protected async requiresCallback(route: RebalanceRoute, fillTxHash: string): Promise<CallbackInfo> {
    const originAsset = findAssetByAddress(route.asset, route.origin, this.chains, this.logger);
    if (!originAsset) {
      throw new Error('Could not find origin asset');
    }

    // Only WETH transfers need callbacks for wrapping
    if (originAsset.symbol.toLowerCase() !== 'weth') {
      this.logger.debug('Asset is not WETH, no callback needed', { route, originAsset });
      return { needsCallback: false };
    }

    const destinationNative = findMatchingDestinationAsset(zeroAddress, 1, route.destination, this.chains, this.logger);
    if (!destinationNative || destinationNative.symbol !== 'ETH') {
      return { needsCallback: false };
    }

    const provider = this.chains[route.destination]?.providers?.[0];
    if (!provider) {
      return { needsCallback: false };
    }

    const client = createPublicClient({ transport: http(provider) });
    const fillReceipt = await client.getTransactionReceipt({ hash: fillTxHash as `0x${string}` });
    const hasWithdrawn = fillReceipt.logs.find((l: { topics: string[] }) => l.topics[0] === WETH_WITHDRAWAL_TOPIC);

    const decodedEvent = parseFillLogs(fillReceipt.logs, {
      inputToken: padHex(route.asset.toLowerCase() as `0x${string}`, { size: 32 }),
      originChainId: BigInt(route.origin),
    });

    if (!decodedEvent) {
      throw new Error(`Failed to find fill logs from receipt`);
    }

    const outputAmount = decodedEvent.outputAmount;
    const recipient = decodedEvent.recipient;
    const balance = await this.getTokenBalance(
      !!hasWithdrawn ? zeroAddress : decodedEvent.outputToken,
      decodedEvent.recipient,
      client,
    );

    if (decodedEvent.outputToken === zeroAddress) {
      return { needsCallback: balance >= outputAmount, amount: outputAmount, recipient };
    }

    const destinationWeth = findMatchingDestinationAsset(
      originAsset.address,
      route.origin,
      route.destination,
      this.chains,
      this.logger,
    );
    if (!destinationWeth) {
      this.logger.debug('No destination WETH found, no callback', { route, event: decodedEvent });
      return { needsCallback: false };
    }

    if (decodedEvent.outputToken.toLowerCase() !== destinationWeth.address.toLowerCase()) {
      this.logger.debug('Output token is not weth', { route, event: decodedEvent });
      return { needsCallback: false };
    }

    return {
      needsCallback: !!hasWithdrawn && balance >= outputAmount,
      amount: outputAmount,
      recipient,
    };
  }

  protected async getTokenBalance(tokenAddress: string, owner: string, client: PublicClient): Promise<bigint> {
    const ownerAddress = owner as `0x${string}`;

    if (tokenAddress.toLowerCase() === zeroAddress.toLowerCase()) {
      // Native balance
      const balance = await client.getBalance({ address: ownerAddress });
      this.logger.debug('Fetched native balance', { owner, balance: balance.toString() });
      return balance;
    }
    // ERC20 token balance
    const contractAddress = tokenAddress as `0x${string}`;
    const balance = await client.readContract({
      address: contractAddress,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [ownerAddress],
    });
    this.logger.debug('Fetched ERC20 token balance', { owner, tokenAddress, balance: balance.toString() });
    return balance;
  }

  // Helper methods for API calls
  protected async getSuggestedFees(route: RebalanceRoute, amount: string): Promise<SuggestedFeesResponse> {
    const outputToken = findMatchingDestinationAsset(
      route.asset,
      route.origin,
      route.destination,
      this.chains,
      this.logger,
      route.destinationAsset,
    );
    if (!outputToken) {
      throw new Error('Could not find matching destination asset');
    }

    const response = await axiosGet<SuggestedFeesResponse>(
      `${this.url}/suggested-fees?inputToken=${route.asset}&outputToken=${outputToken.address}&originChainId=${route.origin}&destinationChainId=${route.destination}&amount=${amount}`,
    );

    return response.data;
  }

  protected async getDepositStatusFromApi(route: RebalanceRoute, depositId: number): Promise<DepositStatusResponse> {
    const response = await axiosGet<DepositStatusResponse>(`${this.url}/deposit/status`, {
      params: {
        originChainId: route.origin,
        depositId,
      },
    });
    return response.data;
  }

  // Helper for error handling
  protected handleError(error: Error | unknown, context: string, metadata: Record<string, unknown>): never {
    this.logger.error(`Failed to ${context}`, {
      error: jsonifyError(error),
      ...metadata,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    throw new Error(`Failed to ${context}: ${(error as any)?.message ?? ''}`);
  }
}
