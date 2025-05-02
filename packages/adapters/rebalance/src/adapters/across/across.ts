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
const FILLED_V3_RELAY_EVENT =
  'FilledV3Relay(address,address,uint256,uint256,uint256,uint256,uint32,uint32,uint32,address,address,address,address,bytes,(address,bytes,uint256,uint8))';
const FILLED_V3_RELAY_TOPIC = keccak256(toHex(FILLED_V3_RELAY_EVENT));

// WETH withdrawal event
const WETH_WITHDRAWAL_EVENT = 'Withdrawal(address,uint256)';
const WETH_WITHDRAWAL_TOPIC = keccak256(toHex(WETH_WITHDRAWAL_EVENT));

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
    this.logger.debug('getReceivedAmount called', { amount, route });

    try {
      // Find the matching output token on the destination chain
      const outputToken = this.findMatchingDestinationAsset(route.asset, route.origin, route.destination);
      this.logger.debug('Found matching destination asset', {
        originAsset: route.asset,
        destinationAsset: outputToken,
        originChain: route.origin,
        destinationChain: route.destination,
      });

      // Get suggested fees from Across API
      this.logger.debug('Requesting suggested fees from Across API', {
        inputToken: route.asset,
        outputToken,
        originChainId: route.origin,
        destinationChainId: route.destination,
        amount,
      });

      const response = await axios.get(`${this.url}/suggested-fees`, {
        params: {
          inputToken: route.asset,
          outputToken,
          originChainId: route.origin,
          destinationChainId: route.destination,
          amount: amount,
        },
      });

      const feesData = response.data as SuggestedFeesResponse;
      this.logger.debug('Received fee data from Across API', {
        totalRelayFee: feesData.totalRelayFee,
        lpFee: feesData.lpFee,
        isAmountTooLow: feesData.isAmountTooLow,
      });

      // Calculate received amount by subtracting fees
      const totalRelayFeeBN = BigInt(feesData.totalRelayFee.total);
      const lpFeeBN = BigInt(feesData.lpFee.total);
      const totalFees = totalRelayFeeBN + lpFeeBN;

      // Convert amount to BigInt and subtract fees
      const amountBN = BigInt(amount);
      const receivedAmount = amountBN - totalFees;

      this.logger.debug('Calculated received amount after fees', {
        originalAmount: amount,
        totalFees: totalFees.toString(),
        receivedAmount: receivedAmount.toString(),
      });

      return receivedAmount.toString();
    } catch (error) {
      this.logger.error('Failed to get received amount from Across', {
        error: jsonifyError(error),
        amount,
        route,
      });
      throw new Error(`Failed to get received amount from Across: ${error}`);
    }
  }

  async send(amount: string, route: RebalanceRoute): Promise<TransactionRequestBase> {
    this.logger.debug('send called', { amount, route });

    try {
      // Find the matching output token on the destination chain
      const outputToken = this.findMatchingDestinationAsset(route.asset, route.origin, route.destination);
      this.logger.debug('Found matching destination asset', {
        originAsset: route.asset,
        destinationAsset: outputToken,
        originChain: route.origin,
        destinationChain: route.destination,
      });

      // Get suggested fees for the transaction
      this.logger.debug('Requesting suggested fees from Across API', {
        inputToken: route.asset,
        outputToken,
        originChainId: route.origin,
        destinationChainId: route.destination,
        amount,
      });

      const feesResponse = (await axios.get(`${this.url}/suggested-fees`, {
        params: {
          inputToken: route.asset,
          outputToken,
          originChainId: route.origin,
          destinationChainId: route.destination,
          amount: amount,
        },
      })) as { data: SuggestedFeesResponse };

      this.logger.debug('Received fee data from Across API', {
        totalRelayFee: feesResponse.data.totalRelayFee,
        lpFee: feesResponse.data.lpFee,
        isAmountTooLow: feesResponse.data.isAmountTooLow,
        spokePoolAddress: feesResponse.data.spokePoolAddress,
      });

      // Check if amount is too low
      if (feesResponse.data.isAmountTooLow) {
        this.logger.warn('Amount is too low for bridging via Across', { amount, route });
        throw new Error('Amount is too low for bridging via Across');
      }

      // Prepare transaction request
      // This is a simplified version - actual implementation would need contract addresses and ABI
      const txRequest: TransactionRequestBase = {
        to: feesResponse.data.spokePoolAddress, // Across spoke pool address from docs
        data: '0x', // This would be the actual contract call data
        value: BigInt(0), // For ETH transfers this would be non-zero
      };

      this.logger.debug('Prepared transaction request', {
        to: txRequest.to,
        value: txRequest.value ? txRequest.value.toString() : '0',
      });

      return txRequest;
    } catch (error) {
      this.logger.error('Failed to prepare Across bridge transaction', {
        error: jsonifyError(error),
        amount,
        route,
      });
      throw new Error(`Failed to prepare Across bridge transaction: ${error}`);
    }
  }

  async destinationCallback(
    amount: string,
    route: RebalanceRoute,
    originTransaction: TransactionReceipt,
  ): Promise<TransactionRequestBase | void> {
    this.logger.debug('destinationCallback called', {
      amount,
      route,
      transactionHash: originTransaction.transactionHash,
    });

    try {
      // Get deposit status from shared helper method
      const statusData = await this.getDepositStatus(route, originTransaction);

      // If no status found, return
      if (!statusData) {
        throw new Error(`Failed to get deposit status for ${originTransaction.transactionHash}`);
      }

      if (statusData.fillStatus !== 'filled' || !statusData.fillTxHash) {
        throw new Error(
          `Transaction (depositId: ${statusData.depositId}) is not yet filled, cannot execute destination callback`,
        );
      }

      // Check if callback is needed and get fill information
      const callbackInfo = await this.requiresCallback(route, statusData.fillTxHash);

      if (!callbackInfo.needsCallback) {
        this.logger.debug('No callback needed for deposit', {
          depositId: statusData.depositId,
          fillStatus: statusData.fillStatus,
        });
        return;
      }

      // If we got here, we need to wrap ETH to WETH
      this.logger.debug('Deposit requires ETH to WETH wrapping', {
        depositId: statusData.depositId,
        fillTxHash: statusData.fillTxHash,
        amount: callbackInfo.amount?.toString(),
      });

      // Find the origin asset configuration
      const originChainConfig = this.chains[route.origin]!;
      const originAsset = originChainConfig.assets.find(
        (a: AssetConfiguration) => a.address.toLowerCase() === route.asset.toLowerCase(),
      );
      if (!originAsset) {
        throw new Error(`Origin asset not found in chain configuration`);
      }
      // Verify it's WETH
      if (originAsset.symbol !== 'WETH') {
        throw new Error(`Expected WETH, but found ${originAsset.symbol}`);
      }

      // Find WETH on the destination chain
      const destinationWETH = this.findMatchingDestinationAsset(route.asset, route.destination, route.origin);
      if (!destinationWETH) {
        throw new Error(`Failed to find destination WETH`);
      }

      // Use the amount from the fill transaction
      const amountToWrap = callbackInfo.amount!;

      this.logger.debug('Found WETH on destination chain', {
        destinationChain: route.destination,
        wethAddress: destinationWETH.address,
        amountToWrap: amountToWrap.toString(),
      });

      // Prepare transaction to wrap ETH to WETH
      // Use the deposit() function on WETH with ETH value

      const txRequest: TransactionRequestBase = {
        to: destinationWETH.address as `0x${string}`,
        data: '0xd0e30db0', // Function selector for deposit()
        value: amountToWrap,
      };

      this.logger.debug('Prepared ETH to WETH wrapping transaction', {
        to: txRequest.to,
        data: txRequest.data,
        value: txRequest.value,
      });

      return txRequest;
    } catch (error) {
      this.logger.error('Failed to prepare destination callback', {
        error: jsonifyError(error),
        amount,
        route,
        transactionHash: originTransaction.transactionHash,
      });
      throw new Error(`Failed to prepare destination callback: ${error}`);
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
        depositId: statusData.depositId,
        fillStatus: statusData.fillStatus,
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
  private async getDepositStatus(
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

      const statusResponse = await axios.get(`${this.url}/deposit/status`, {
        params: {
          originChainId: route.origin,
          depositId,
        },
      });

      const statusData = statusResponse.data as DepositStatusResponse;
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
  private extractDepositId(receipt: TransactionReceipt): number | undefined {
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
  private async requiresCallback(route: RebalanceRoute, fillTxHash: string): Promise<CallbackInfo> {
    this.logger.debug('Checking if callback is required', {
      asset: route.asset,
      origin: route.origin,
      destination: route.destination,
      fillTxHash,
    });

    // Get chain configs
    const originChainConfig = this.chains[route.origin];
    const destinationChainConfig = this.chains[route.destination];
    if (!originChainConfig || !destinationChainConfig) {
      const error = new Error(`Missing chain configs for route`);
      this.logger.error(error.message, {
        route,
        chains: Object.keys(this.chains),
        error: jsonifyError(error),
      });
      throw error;
    }

    // Find the asset in the origin chain
    const originAsset = originChainConfig.assets.find(
      (a: AssetConfiguration) => a.address.toLowerCase() === route.asset.toLowerCase(),
    );

    if (!originAsset) {
      const error = new Error(`Missing asset configs for origin asset`);
      this.logger.error(error.message, {
        route,
        chains: Object.keys(this.chains),
        error: jsonifyError(error),
      });
      throw error;
    }

    // Check specifically for WETH symbol
    const isWETH = originAsset.symbol === 'WETH';

    if (!isWETH) {
      this.logger.debug('Asset is not WETH, no callback needed', {
        asset: route.asset,
        originChain: route.origin,
        symbol: originAsset.symbol,
      });
      return { needsCallback: false };
    }

    // Verify the destination chain has ETH configured as a native asset
    const destinationNative = this.findMatchingDestinationAsset(zeroAddress, route.origin, route.destination);
    if (!destinationNative || destinationNative.symbol !== 'ETH') {
      this.logger.debug('Destination chain does not have native ETH', {
        destination: route.destination,
      });
      return { needsCallback: false };
    }

    // Now examine the actual fill transaction to determine if ETH was delivered
    // First, find a provider for the destination chain
    const provider = destinationChainConfig.providers?.[0];
    if (!provider) {
      this.logger.warn('No provider available for destination chain', {
        destination: route.destination,
      });
      return { needsCallback: false };
    }

    // Create a temporary client to fetch the transaction receipt
    // TODO: chainservice?
    const client = createPublicClient({
      transport: http(provider),
    });

    // Get the fill transaction receipt
    const fillReceipt = await client.getTransactionReceipt({
      hash: fillTxHash as `0x${string}`,
    });

    this.logger.debug('Retrieved fill transaction receipt', {
      fillTxHash,
      logsCount: fillReceipt.logs.length,
    });

    // Check that the received asset is empty (native) OR
    // destination WETH and there is a withdrawn asset
    const hasFilled = fillReceipt.logs.find((l) => l.topics[0] === FILLED_V3_RELAY_TOPIC);
    const hasWithdrawn = fillReceipt.logs.find((l) => l.topics[0] === WETH_WITHDRAWAL_TOPIC);
    if (!hasFilled) {
      const error = new Error(`No fill event found for fill tx hash`);
      this.logger.error(error.message, {
        route,
        fillTxHash,
        error: jsonifyError(error),
      });
      throw error;
    }

    const parsedFill = decodeEventLog({
      abi: ACROSS_SPOKE_ABI,
      data: hasFilled.data,
      topics: hasFilled.topics,
      eventName: 'FilledV3Relay',
    });

    if (
      !parsedFill.args ||
      !('outputToken' in parsedFill.args) ||
      !('recipient' in parsedFill.args) ||
      !('outputAmount' in parsedFill.args)
    ) {
      const error = new Error(`Failed to parse logs for fill event`);
      this.logger.error(error.message, {
        route,
        fillTxHash,
        error: jsonifyError(error),
        parsedFill,
        topic: FILLED_V3_RELAY_TOPIC,
      });
      throw error;
    }

    // Extract the output amount from the fill event - this is what we need to wrap
    const outputAmount = BigInt((parsedFill.args.outputAmount as string).toString());
    const recipient = parsedFill.args.recipient as string;

    // If the output asset is empty, requires a callback - ETH was delivered
    if (parsedFill.args.outputToken === zeroHash) {
      this.logger.debug(`Output token is ETH, needs to be wrapped to WETH`, {
        outputAmount: outputAmount?.toString(),
        recipient,
        route,
        fillTxHash,
      });
      return {
        needsCallback: true,
        amount: outputAmount,
        recipient,
      };
    }

    // If the output token is not weth, does not require callback
    const destinationWeth = this.findMatchingDestinationAsset(originAsset.address, route.origin, route.destination);
    if (
      parsedFill.args.outputToken !== padHex((destinationWeth?.address ?? zeroAddress) as `0x${string}`, { size: 32 })
    ) {
      this.logger.debug(`Output token is not weth, no callback needed`, {
        parsedFill,
        destinationWeth,
        route,
        fillTxHash,
      });
      return { needsCallback: false };
    }

    // Output token _is_ weth, a callback is required IFF there is a withdrawn event
    // NOTE: this assumes that there is _not_ a withdraw event from some other operation in the
    // transaction (ie solver has weth, withdraws, fills in eth)
    return {
      needsCallback: !!hasWithdrawn,
      amount: outputAmount,
      recipient,
    };
  }
}
