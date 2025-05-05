import {
  TransactionReceipt,
  TransactionRequestBase,
  createPublicClient,
  decodeEventLog,
  http,
  keccak256,
  padHex,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem';
import axios from 'axios';
import { AssetConfiguration, ChainConfiguration } from '@mark/core';
import { jsonifyError, Logger } from '@mark/logger';
import { BridgeAdapter, SupportedBridge, RebalanceRoute } from '../../types';
import { SuggestedFeesResponse, DepositStatusResponse } from './types';
import { ACROSS_SPOKE_ABI } from './abi';

// Event signatures
const V3_FUNDS_DEPOSITED_EVENT =
  'V3FundsDeposited(address,address,uint256,uint256,uint256,uint32,uint32,uint32,uint32,address,address,address,bytes)';
const V3_FUNDS_DEPOSITED_TOPIC = keccak256(toHex(V3_FUNDS_DEPOSITED_EVENT));

// Fill event and topic
export const FILLED_V3_RELAY_EVENT =
  'FilledV3Relay(address,address,uint256,uint256,uint256,uint256,uint32,uint32,uint32,address,address,address,address,bytes,(address,bytes,uint256,uint8))';
export const FILLED_V3_RELAY_TOPIC = '0x571749edf1d5c9599318cdbc4e28a6475d65e87fd3b2ddbe1e9a8d5e7a0f0ff7'; //keccak256(toHex(FILLED_V3_RELAY_EVENT));

// WETH withdrawal event
export const WETH_WITHDRAWAL_EVENT = 'Withdrawal(address,uint256)';
export const WETH_WITHDRAWAL_TOPIC = '0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7';

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
    return 'across';
  }

  async getReceivedAmount(amount: string, route: RebalanceRoute): Promise<string> {
    try {
      const feesData = await this.getSuggestedFees(route, amount);

      if (feesData.isAmountTooLow) {
        throw new Error('Amount is too low for suggested route via across');
      }

      const totalFees = BigInt(feesData.totalRelayFee.total) + BigInt(feesData.lpFee.total);
      const receivedAmount = BigInt(amount) - totalFees;

      return receivedAmount.toString();
    } catch (error) {
      this.handleError(error, 'get received amount from Across', { amount, route });
    }
  }

  async send(amount: string, route: RebalanceRoute): Promise<TransactionRequestBase> {
    try {
      const feesData = await this.getSuggestedFees(route, amount);

      if (feesData.isAmountTooLow) {
        throw new Error('Amount is too low for bridging via Across');
      }

      return {
        to: feesData.spokePoolAddress,
        data: '0x',
        value: BigInt(0),
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
      if (!statusData || statusData.fillStatus !== 'filled' || !statusData.fillTxHash) {
        throw new Error(`Transaction (depositId: ${statusData?.depositId}) is not yet filled`);
      }

      const callbackInfo = await this.requiresCallback(route, statusData.fillTxHash);
      if (!callbackInfo.needsCallback) {
        return;
      }

      const originAsset = this.findMatchingDestinationAsset(route.asset, route.origin, route.destination);
      this.validateAsset(originAsset, 'WETH', 'origin asset');

      const destinationWETH = this.findMatchingDestinationAsset(route.asset, route.destination, route.origin);
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
      const isReady = statusData.fillStatus === 'filled';
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
  ): Promise<(DepositStatusResponse & { depositId: number }) | undefined> {
    try {
      // Extract deposit ID from the transaction receipt
      const depositId = this.extractDepositId(originTransaction);

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
        fillStatus: statusData.fillStatus,
        destinationChainId: statusData.destinationChainId,
        fillTxHash: statusData.fillTxHash,
      });

      // Return status data with depositId attached
      return {
        ...statusData,
        depositId,
      };
    } catch (error) {
      this.logger.error('Failed to get deposit status', {
        error: jsonifyError(error),
        route,
        transactionHash: originTransaction.transactionHash,
      });
      throw error;
    }
  }

  // Helper method to find the matching destination token address
  protected findMatchingDestinationAsset(
    asset: string,
    origin: number,
    destination: number,
  ): AssetConfiguration | undefined {
    this.logger.debug('Finding matching destination asset', { asset, origin, destination });

    const originChainConfig = this.chains[origin.toString()];
    const destinationChainConfig = this.chains[destination.toString()];

    if (!originChainConfig) {
      this.logger.warn(`Origin chain configuration not found`, { asset, origin, destination });
      return undefined;
    }

    if (!destinationChainConfig) {
      this.logger.warn(`Destination chain configuration not found`, { asset, origin, destination });
      return undefined;
    }

    // Find the asset in the origin chain
    const originAsset = originChainConfig.assets.find(
      (a: AssetConfiguration) => a.address.toLowerCase() === asset.toLowerCase(),
    );

    if (!originAsset) {
      this.logger.warn(`Asset not found on origin chain`, { asset, origin });
      return undefined;
    }

    this.logger.debug('Found matching asset in origin chain', {
      asset,
      origin,
      originAsset,
    });

    // Find the matching asset in the destination chain by symbol
    const destinationAsset = destinationChainConfig.assets.find(
      (a: AssetConfiguration) => a.symbol === originAsset.symbol,
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
  protected extractDepositId(receipt: TransactionReceipt): number | undefined {
    this.logger.debug('Extracting deposit ID from transaction receipt', {
      transactionHash: receipt.transactionHash,
      logsCount: receipt.logs.length,
    });

    try {
      // Find the V3FundsDeposited event in the logs
      for (const log of receipt.logs) {
        // Check if the first topic matches our event signature
        if (log.topics[0] === V3_FUNDS_DEPOSITED_TOPIC) {
          this.logger.debug('Found V3FundsDeposited event in transaction logs', {
            address: log.address,
            logIndex: log.logIndex,
            transactionHash: receipt.transactionHash,
          });

          try {
            // Decode the event data
            const result = decodeEventLog({
              abi: ACROSS_SPOKE_ABI,
              data: log.data,
              topics: log.topics,
              eventName: 'V3FundsDeposited',
            });

            // Check if the depositId exists in the args
            if (result && result.args && 'depositId' in result.args) {
              const depositId = Number(result.args.depositId);
              this.logger.debug('Successfully decoded deposit ID from event', {
                depositId,
                transactionHash: receipt.transactionHash,
              });
              return depositId;
            }

            this.logger.warn('Failed to extract depositId from decoded event args', {
              hasArgs: !!result?.args,
              transactionHash: receipt.transactionHash,
            });
          } catch (decodeError) {
            this.logger.error('Error decoding event log', {
              error: decodeError instanceof Error ? decodeError.message : String(decodeError),
              transactionHash: receipt.transactionHash,
              logIndex: log.logIndex,
            });

            // Alternative approach: since depositId is the 6th parameter and is indexed,
            // it should be in the second topic (index 1)
            // Topics format: [eventSignature, indexed1, indexed2, indexed3...]
            if (log.topics.length > 1 && log.topics[1]) {
              // Convert the hex string to a number
              const depositIdHex = log.topics[1];
              const depositId = parseInt(depositIdHex.slice(2), 16);

              this.logger.debug('Extracted deposit ID from event topic as fallback', {
                depositId,
                topicIndex: 1,
                transactionHash: receipt.transactionHash,
              });

              return depositId;
            }

            this.logger.warn('Could not extract deposit ID using fallback method', {
              topicsLength: log.topics.length,
              transactionHash: receipt.transactionHash,
            });
          }
        }
      }

      this.logger.warn('No Across deposit event found in transaction receipt', {
        transactionHash: receipt.transactionHash,
      });

      return undefined;
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
    const originAsset = this.findMatchingDestinationAsset(route.asset, route.origin, route.destination);
    if (!originAsset) {
      throw new Error('Could not find origin asset');
    }
    this.validateAsset(originAsset, 'WETH', 'origin asset');

    const destinationNative = this.findMatchingDestinationAsset(zeroAddress, route.origin, route.destination);
    if (!destinationNative || destinationNative.symbol !== 'ETH') {
      return { needsCallback: false };
    }

    const provider = this.chains[route.destination]?.providers?.[0];
    if (!provider) {
      return { needsCallback: false };
    }

    const client = createPublicClient({ transport: http(provider) });
    const fillReceipt = await client.getTransactionReceipt({ hash: fillTxHash as `0x${string}` });

    const hasFilled = fillReceipt.logs.find((l) => l.topics[0] === FILLED_V3_RELAY_TOPIC);
    const hasWithdrawn = fillReceipt.logs.find((l) => l.topics[0] === WETH_WITHDRAWAL_TOPIC);

    if (!hasFilled) {
      console.log('FILLED_V3_RELAY_TOPIC', FILLED_V3_RELAY_TOPIC);
      throw new Error('No fill event found for fill tx hash');
    }

    const decodedEvent = decodeEventLog({
      abi: ACROSS_SPOKE_ABI,
      data: hasFilled.data,
      topics: hasFilled.topics,
      eventName: 'FilledV3Relay',
    });

    if (
      !decodedEvent.args ||
      !('outputToken' in decodedEvent.args) ||
      !('recipient' in decodedEvent.args) ||
      !('outputAmount' in decodedEvent.args)
    ) {
      throw new Error('Failed to parse logs for fill event');
    }

    const outputAmount = BigInt(decodedEvent.args.outputAmount as string);
    const recipient = decodedEvent.args.recipient as string;

    if (decodedEvent.args.outputToken === zeroHash) {
      return { needsCallback: true, amount: outputAmount, recipient };
    }

    const destinationWeth = this.findMatchingDestinationAsset(originAsset.address, route.origin, route.destination);
    if (!destinationWeth) {
      return { needsCallback: false };
    }

    if (decodedEvent.args.outputToken !== padHex(destinationWeth.address as `0x${string}`, { size: 32 })) {
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

    const response = await axios.get(`${this.url}/suggested-fees`, {
      params: {
        inputToken: route.asset,
        outputToken: outputToken.address,
        originChainId: route.origin,
        destinationChainId: route.destination,
        amount,
      },
    });

    return response.data as SuggestedFeesResponse;
  }

  protected async getDepositStatusFromApi(route: RebalanceRoute, depositId: number): Promise<DepositStatusResponse> {
    const response = await axios.get(`${this.url}/deposit/status`, {
      params: {
        originChainId: route.origin,
        depositId,
      },
    });
    return response.data as DepositStatusResponse;
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
