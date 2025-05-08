import {
  TransactionReceipt,
  TransactionRequestBase,
  createPublicClient,
  encodeFunctionData,
  http,
  padHex,
  zeroAddress,
} from 'viem';
import axios from 'axios';
import { AssetConfiguration, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, SupportedBridge, RebalanceRoute } from '../../types';
import { SuggestedFeesResponse, DepositStatusResponse, WETH_WITHDRAWAL_TOPIC } from './types';
import { parseFillLogs, getDepositFromLogs } from './utils';
import { ACROSS_SPOKE_ABI } from './abi';

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
  ): Promise<TransactionRequestBase> {
    try {
      const feesData = await this.getSuggestedFees(route, amount);

      if (feesData.isAmountTooLow) {
        throw new Error('Amount is too low for bridging via Across');
      }

      return {
        to: feesData.spokePoolAddress,
        data: encodeFunctionData({
          abi: ACROSS_SPOKE_ABI,
          functionName: 'deposit',
          args: [
            padHex(sender as `0x${string}`, { size: 32 }),
            padHex(recipient as `0x${string}`, { size: 32 }),
            padHex(route.asset as `0x${string}`, { size: 32 }),
            padHex(
              this.findMatchingDestinationAsset(route.asset, route.origin, route.destination)!.address as `0x${string}`,
              { size: 32 },
            ),
            BigInt(amount), // input amount
            feesData.outputAmount, // output amount,
            BigInt(route.destination), // destination
            padHex(feesData.exclusiveRelayer, { size: 32 }), // exclusive relayer
            feesData.timestamp, // quote timestamp,
            feesData.fillDeadline, // fill deadline
            feesData.exclusivityDeadline, // exclusivity parameter
            '', // message
          ],
        }),
        value: route.asset === zeroAddress ? BigInt(amount) : BigInt(0),
      };
    } catch (error) {
      this.handleError(error, 'prepare Across bridge transaction', { amount, route });
    }
  }

  async destinationCallback(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<TransactionRequestBase | void> {
    try {
      const statusData = await this.getDepositStatus(route, originTransaction);
      if (!statusData || statusData.status !== 'filled' || !statusData.fillTx) {
        throw new Error(`Transaction (depositId: ${statusData?.depositId}) is not yet filled`);
      }

      const callbackInfo = await this.requiresCallback(route, statusData.fillTx);
      if (!callbackInfo.needsCallback) {
        return;
      }

      const originAsset = this.findMatchingDestinationAsset(route.asset, route.origin, route.destination);
      this.validateAsset(originAsset, 'WETH', 'origin asset');

      const destinationWETH = this.findMatchingDestinationAsset(route.asset, route.origin, route.destination);
      if (!destinationWETH) {
        throw new Error('Failed to find destination WETH');
      }

      return {
        to: destinationWETH.address as `0x${string}`,
        data: '0xd0e30db0', // deposit() function selector
        value: callbackInfo.amount!,
      };
    } catch (error) {
      this.handleError(error, 'prepare destination callback', {
        amount,
        route,
        transactionHash: originTransaction.transactionHash,
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

  protected getAsset(asset: string, chain: number): AssetConfiguration | undefined {
    this.logger.debug('Finding matching asset', { asset, chain });

    const chainConfig = this.chains[chain.toString()];
    if (!chainConfig) {
      this.logger.warn(`Chain configuration not found`, { asset, chain });
      return undefined;
    }

    return chainConfig.assets.find((a: AssetConfiguration) => a.address.toLowerCase() === asset.toLowerCase());
  }

  // Helper method to find the matching destination token address
  protected findMatchingDestinationAsset(
    asset: string,
    origin: number,
    destination: number,
  ): AssetConfiguration | undefined {
    this.logger.debug('Finding matching destination asset', { asset, origin, destination });

    const destinationChainConfig = this.chains[destination.toString()];

    if (!destinationChainConfig) {
      this.logger.warn(`Destination chain configuration not found`, { asset, origin, destination });
      return undefined;
    }

    // Find the asset in the origin chain
    const originAsset = this.getAsset(asset, origin);
    if (!originAsset) {
      this.logger.warn(`Asset not found on origin chain`, { asset, origin });
      return undefined;
    }

    this.logger.debug('Found asset in origin chain', {
      asset,
      origin,
      originAsset,
    });

    // Find the matching asset in the destination chain by symbol
    const destinationAsset = destinationChainConfig.assets.find(
      (a: AssetConfiguration) => a.symbol.toLowerCase() === originAsset.symbol.toLowerCase(),
    );

    if (!destinationAsset) {
      this.logger.warn(`Matching asset not found in destination chain`, {
        asset: originAsset,
        destination,
      });
      return undefined;
    }

    this.logger.debug('Found matching asset in destination chain', {
      originAsset,
      destinationAsset,
    });

    return destinationAsset;
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
    const originAsset = this.getAsset(route.asset, route.origin);
    if (!originAsset) {
      throw new Error('Could not find origin asset');
    }
    this.validateAsset(originAsset, 'WETH', 'origin asset');

    const destinationNative = this.findMatchingDestinationAsset(zeroAddress, 1, route.destination);
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
      inputToken: padHex(route.asset as `0x${string}`, { size: 32 }),
      originChainId: BigInt(route.origin),
    });

    if (!decodedEvent) {
      throw new Error(`Failed to find fill logs from receipt`);
    }

    const outputAmount = decodedEvent.outputAmount;
    const recipient = decodedEvent.recipient;

    if (decodedEvent.outputToken === zeroAddress) {
      return { needsCallback: true, amount: outputAmount, recipient };
    }

    const destinationWeth = this.findMatchingDestinationAsset(originAsset.address, route.origin, route.destination);
    if (!destinationWeth) {
      this.logger.debug('No destination WETH found, no callback', { route, event: decodedEvent });
      return { needsCallback: false };
    }

    if (decodedEvent.outputToken.toLowerCase() !== destinationWeth.address.toLowerCase()) {
      this.logger.debug('Output token is not weth', { route, event: decodedEvent });
      return { needsCallback: false };
    }

    return {
      needsCallback: !!hasWithdrawn,
      amount: outputAmount,
      recipient,
    };
  }

  // Helper methods for API calls
  protected async getSuggestedFees(route: RebalanceRoute, amount: string): Promise<SuggestedFeesResponse> {
    const outputToken = this.findMatchingDestinationAsset(route.asset, route.origin, route.destination);
    if (!outputToken) {
      throw new Error('Could not find matching destination asset');
    }

    const response = await axios.get<SuggestedFeesResponse>(`${this.url}/suggested-fees`, {
      params: {
        inputToken: route.asset,
        outputToken: outputToken.address,
        originChainId: route.origin,
        destinationChainId: route.destination,
        amount,
      },
    });

    return response.data;
  }

  protected async getDepositStatusFromApi(route: RebalanceRoute, depositId: number): Promise<DepositStatusResponse> {
    const response = await axios.get<DepositStatusResponse>(`${this.url}/deposit/status`, {
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

  // Helper for asset validation
  protected validateAsset(asset: AssetConfiguration | undefined, expectedSymbol: string, context: string): void {
    if (!asset) {
      throw new Error(`Missing asset configs for ${context}`);
    }
    if (asset.symbol.toLowerCase() !== expectedSymbol.toLowerCase()) {
      throw new Error(`Expected ${expectedSymbol}, but found ${asset.symbol}`);
    }
  }
}
