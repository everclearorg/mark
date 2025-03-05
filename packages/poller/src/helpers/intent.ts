import { MarkConfiguration, NewIntentParams } from '@mark/core';
import { ProcessInvoicesDependencies } from '../invoice/pollAndProcess';
import { getERC20Contract, MULTICALL_ADDRESS, multicallAbi } from './contracts';
import { encodeFunctionData, erc20Abi } from 'viem';
import { TransactionReason } from '@mark/prometheus';
import {
  generatePermit2Nonce,
  generatePermit2Deadline,
  getPermit2Signature,
  approvePermit2,
  PERMIT2_ADDRESS,
} from './permit2';

export const INTENT_ADDED_TOPIC0 = '0xefe68281645929e2db845c5b42e12f7c73485fb5f18737b7b29379da006fa5f7';

/**
 * Uses the api to get the tx data and chainservice to send intents and approve assets if required. Takes in the origin-asset batched intents.
 */
export const sendIntents = async (
  intents: NewIntentParams[],
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
): Promise<{ transactionHash: string; chainId: string; intentId: string }[]> => {
  const { everclear, logger, chainService, prometheus } = deps;
  const results: { transactionHash: string; chainId: string; intentId: string }[] = [];
  logger.info('Attempting to send batched intents', { batch: intents });

  try {
    for (const intent of intents) {
      logger.info('Processing intent for new transaction', { intent });

      // Fetch transaction data for creating a new intent
      const txData = await everclear.createNewIntent(intent);

      logger.debug('Received transaction data for new intent', { txData });

      // Ensure allowance for the transaction
      const tokenContract = await getERC20Contract(config, intent.origin, intent.inputAsset as `0x${string}`);
      const allowance = await tokenContract.read.allowance([config.ownAddress, txData.to]);

      if (BigInt(allowance as string) < BigInt(intent.amount)) {
        logger.info('Allowance insufficient, preparing approval transaction', {
          requiredAmount: intent.amount,
          currentAllowance: allowance,
        });

        const approveCalldata = encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [txData.to as `0x${string}`, BigInt(intent.amount)],
        });
        const transaction = {
          to: tokenContract.address,
          data: approveCalldata,
          from: config.ownAddress,
        };

        logger.debug('Sending approval transaction', { transaction, chainId: txData.chainId });
        const approvalTx = await chainService.submitAndMonitor(txData.chainId.toString(), transaction);
        prometheus.updateGasSpent(
          intent.origin,
          TransactionReason.Approval,
          BigInt(approvalTx.cumulativeGasUsed.mul(approvalTx.effectiveGasPrice).toString()),
        );

        logger.info('Approval transaction sent successfully', {
          chain: txData.chainId,
          approvalTxHash: approvalTx.transactionHash,
          allowance,
          asset: tokenContract.address,
          amount: intent.amount,
        });
      } else {
        logger.info('Sufficient allowance already available', {
          allowance,
          chain: txData.chainId,
          asset: tokenContract.address,
          amount: intent.amount,
        });
      }

      // Submit the create intent transaction
      logger.info('Submitting create intent transaction', {
        intent,
        transaction: {
          to: txData.to,
          value: txData.value,
          data: txData.data,
          from: txData.from,
          chain: txData.chainId,
        },
      });

      const intentTx = await chainService.submitAndMonitor(txData.chainId.toString(), {
        to: txData.to as string,
        value: txData.value ?? '0',
        data: txData.data,
        from: txData.from ?? config.ownAddress,
      });

      // Get the intent id
      const event = intentTx.logs.find((l) => l.topics[0].toLowerCase() === INTENT_ADDED_TOPIC0)!;
      const intentId = event.topics[1];

      logger.info('Create intent transaction sent successfully', {
        intentTxHash: intentTx.transactionHash,
        chainId: intent.origin,
        intentId,
      });
      prometheus.updateGasSpent(
        intent.origin,
        TransactionReason.CreateIntent,
        BigInt(intentTx.cumulativeGasUsed.mul(intentTx.effectiveGasPrice).toString()),
      );

      // Add result to the output array
      results.push({ transactionHash: intentTx.transactionHash, chainId: intent.origin, intentId });
    }
    return results;
  } catch (err) {
    const error = err as Error;
    logger.error('Error encountered while sending intents', {
      message: error.message,
      name: error.name,
      stack: error.stack,
    });
    throw new Error(`Failed to send intents: ${error.message || err}`);
  }
};

/**
 * Prepares a multicall transaction to batch multiple intent creation calls
 * @param calls - Array of transaction data objects from createNewIntent calls
 * @param sendValues - Whether the calls include ETH values
 * @returns The multicall transaction data
 */
export const prepareMulticall = (
  calls: Array<{
    to: string;
    data: string;
    value?: string;
  }>,
  sendValues = false,
): {
  to: string;
  data: string;
  value?: string;
} => {
  let calldata: string;
  let totalValue = BigInt(0);

  if (sendValues) {
    // Format the calls for the multicall contract with values
    const multicallCalls = calls.map((call) => {
      const value = BigInt(call.value || '0');
      totalValue += value;

      return {
        target: call.to as `0x${string}`,
        allowFailure: false,
        value: value,
        callData: call.data as `0x${string}`,
      };
    });

    // Encode the multicall function call using aggregate3Value
    calldata = encodeFunctionData({
      abi: multicallAbi,
      functionName: 'aggregate3Value',
      args: [multicallCalls],
    });
  } else {
    // Format the calls for the multicall contract without values
    const multicallCalls = calls.map((call) => {
      return {
        target: call.to as `0x${string}`,
        allowFailure: false,
        callData: call.data as `0x${string}`,
      };
    });

    // Encode the multicall function call using aggregate3
    calldata = encodeFunctionData({
      abi: multicallAbi,
      functionName: 'aggregate3',
      args: [multicallCalls],
    });
  }

  return {
    to: MULTICALL_ADDRESS,
    data: calldata,
    value: totalValue.toString(),
  };
};

/**
 * Sends multiple intents in a single transaction using Multicall3 with Permit2 for token approvals
 * @param intents The intents to send with Permit2 parameters
 * @param deps The process dependencies (chainService, everclear, logger, etc.)
 * @returns Object containing transaction hash, chain ID, and a joined string of intent IDs
 */
export const sendIntentsMulticall = async (
  intents: NewIntentParams[],
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
  spokeAddress: string,
): Promise<{ transactionHash: string; chainId: string; intentId: string }> => {
  if (!intents || intents.length === 0) {
    throw new Error('No intents provided for multicall');
  }

  const { chainService, everclear, logger, prometheus, web3Signer } = deps;

  const txs = [];

  // Same chain for all multicalled intents
  const chainId = intents[0].origin;

  // Create a combined intent ID for tracking
  const combinedIntentId = intents
    .map((i) => i.to)
    .join('_')
    .slice(0, 42);

  logger.info('Preparing multicall for intents with Permit2', {
    intentCount: intents.length,
    chainId,
    combinedIntentId,
  });

  // Get unique tokens from all intents
  const uniqueTokens = [...new Set(intents.map((intent) => intent.inputAsset))];

  try {
    // Check Permit2 allowances for each token
    for (const tokenAddress of uniqueTokens) {
      try {
        // Check if Mark already has sufficient allowance for Permit2
        const tokenContract = await getERC20Contract(config, chainId, tokenAddress as `0x${string}`);
        const allowance = await tokenContract.read.allowance([config.ownAddress, PERMIT2_ADDRESS as `0x${string}`]);

        // Simplification here, we assume Mark sets infinite approve on Permit2
        const hasAllowance = BigInt(allowance as string) > 0n;
        if (hasAllowance) continue;

        // If not approved yet, set infinite approve on Permit2
        await approvePermit2(tokenAddress as `0x${string}`, chainService);

        logger.info('Successfully signed and submitted Permit2 approval', {
          tokenAddress,
          chainId,
        });
      } catch (error) {
        logger.error('Error signing/submitting Permit2 approval', {
          error: error instanceof Error ? error.message : error,
          tokenAddress,
          chainId,
        });
        throw error;
      }
    }

    // Generate a unique nonce for this batch of permits
    const nonce = generatePermit2Nonce();
    const deadline = generatePermit2Deadline();

    for (const intent of intents) {
      const tokenAddress = intent.inputAsset;
      const spender = spokeAddress;
      const amount = intent.amount.toString();

      // Get the Permit2 signature and request transaction data
      try {
        const signature = await getPermit2Signature(
          web3Signer,
          parseInt(chainId),
          tokenAddress,
          spender,
          amount,
          nonce,
          deadline,
        );

        // Add Permit2 parameters to the intent
        const intentWithPermit = {
          ...intent,
          permit2Params: {
            nonce,
            deadline: deadline.toString(),
            signature,
          },
        };

        // Fetch transaction data for Permit2-enabled newIntent
        const txData = await everclear.createNewIntent(intentWithPermit);

        // Add transaction to the batch
        txs.push({
          to: txData.to as `0x${string}`,
          data: txData.data,
          value: '0', // Only sending ERC20 tokens, no native value
        });
      } catch (error) {
        logger.error('Error signing Permit2 message or fetching transaction data', {
          error: error instanceof Error ? error.message : error,
          tokenAddress,
          spender,
          amount,
          nonce,
          deadline: deadline.toString(),
        });
        throw error;
      }
    }

    // Prepare the multicall transaction (not sending native)
    const multicallTx = prepareMulticall(txs, false);

    logger.info('Preparing to submit multicall transaction', {
      to: multicallTx.to,
      chainId,
      combinedIntentId,
    });

    const receipt = await chainService.submitAndMonitor(chainId.toString(), {
      to: multicallTx.to,
      data: multicallTx.data,
      value: '0',
    });

    logger.info('Multicall transaction confirmed', {
      transactionHash: receipt.transactionHash,
      chainId,
      combinedIntentId,
    });

    // Track gas spent for the multicall transaction
    if (prometheus) {
      prometheus.updateGasSpent(
        chainId.toString(),
        TransactionReason.CreateIntent,
        BigInt(receipt.cumulativeGasUsed.mul(receipt.effectiveGasPrice).toString()),
      );
    }

    return {
      transactionHash: receipt.transactionHash,
      chainId: chainId.toString(),
      intentId: combinedIntentId,
    };
  } catch (error) {
    logger.error('Failed to submit multicall transaction', {
      error,
      chainId,
      intentCount: intents.length,
    });
    throw error;
  }
};
