import { MarkConfiguration, NewIntentParams } from '@mark/core';
import { ProcessInvoicesDependencies } from '../invoice/pollAndProcess';
import { getERC20Contract } from './contracts';
import { encodeFunctionData, erc20Abi } from 'viem';
import { TransactionReason } from '@mark/prometheus';
import {
  generatePermit2Nonce,
  generatePermit2Deadline,
  getPermit2Signature,
  approvePermit2,
  getPermit2Address,
} from './permit2';
import { prepareMulticall } from './multicall';

export const INTENT_ADDED_TOPIC0 = '0xefe68281645929e2db845c5b42e12f7c73485fb5f18737b7b29379da006fa5f7';

/**
 * Uses the api to get the tx data and chainservice to send intents and approve assets if required.
 * Automatically handles batching through multicall if multiple intents are provided.
 */
export const sendIntents = async (
  intents: NewIntentParams[],
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
): Promise<{ transactionHash: string; chainId: string; intentId: string }[]> => {
  const { everclear, logger, chainService, prometheus } = deps;

  if (intents.length === 0) {
    logger.info('No intents to process');
    return [];
  }

  // If there's more than one intent, check they all have the same origin domain
  if (intents.length > 1) {
    const origins = new Set(intents.map((intent) => intent.origin));

    // If all intents have the same origin domain, use multicall
    if (origins.size === 1) {
      logger.info('Multiple intents with same origin detected, using multicall', {
        count: intents.length,
        origin: intents[0].origin,
      });
      const result = await sendIntentsMulticall(intents, deps, config);
      return [result];
    } else {
      // Should not have different origins
      throw new Error('Cannot process multiple intents with different origin domains');
    }
  }

  logger.info('Processing a single intent', { intent: intents[0] });
  const results: { transactionHash: string; chainId: string; intentId: string }[] = [];

  try {
    const intent = intents[0];
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
 * Sends multiple intents in a single transaction using Multicall3 with Permit2 for token approvals
 * @param intents The intents to send with Permit2 parameters
 * @param deps The process dependencies (chainService, everclear, logger, etc.)
 * @returns Object containing transaction hash, chain ID, and a joined string of intent IDs
 */
export const sendIntentsMulticall = async (
  intents: NewIntentParams[],
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
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

  try {
    try {
      // Check if Mark already has sufficient allowance for Permit2
      const tokenContract = await getERC20Contract(config, chainId, intents[0].inputAsset as `0x${string}`);
      const permit2Address = getPermit2Address(chainId, config);
      const allowance = await tokenContract.read.allowance([config.ownAddress, permit2Address as `0x${string}`]);

      // Simplification here, we assume Mark sets infinite approve on Permit2
      const hasAllowance = BigInt(allowance as string) > 0n;

      console.log('------------Current Permit2 allowance:', {
        tokenAddress: tokenContract.address,
        permit2Address,
        allowance: (allowance as bigint).toString(),
        hasAllowance
      });

      // If not approved yet, set infinite approve on Permit2
      if (!hasAllowance) {
        console.log('------------Insufficient allowance, submitting approval');
        const txHash = await approvePermit2(tokenContract.address as `0x${string}`, chainService, config);
        logger.info('Permit2 approval transaction submitted', {
          txHash,
          tokenAddress: tokenContract.address,
          chainId,
        });
        
        // Verify allowance again after approval to ensure it worked
        const newAllowance = await tokenContract.read.allowance([config.ownAddress, permit2Address as `0x${string}`]);
        const newHasAllowance = BigInt(newAllowance as string) > 0n;
        
        console.log('------------New Permit2 allowance after approval:', {
          tokenAddress: tokenContract.address,
          permit2Address,
          allowance: (newAllowance as bigint).toString(),
          hasAllowance: newHasAllowance,
          txHash
        });
        
        if (!newHasAllowance) {
          throw new Error(`Permit2 approval transaction was submitted (${txHash}) but allowance is still zero`);
        }
      } else {
        console.log('------------Sufficient Permit2 allowance already exists');
      }

      logger.info('Successfully checked Permit2 approval', {
        tokenAddress: tokenContract.address,
        chainId,
      });
    } catch (error) {
      logger.error('Error signing/submitting Permit2 approval', {
        error: error instanceof Error ? error.message : error,
        chainId,
      });
      throw error;
    }

    // Generate a unique nonce for this batch of permits
    const nonce = generatePermit2Nonce();
    const deadline = generatePermit2Deadline();
    
    // Track used nonces to avoid duplicates
    const usedNonces = new Set();
    for (let i = 0; i < intents.length; i++) {
      const intent = intents[i];
      // Generate a unique nonce for each intent to avoid conflicts
      // Add an index suffix to ensure uniqueness within this batch
      const intentNonce = nonce + i.toString().padStart(2, '0');
      const tokenAddress = intent.inputAsset;
      const spender = config!.chains[chainId]!.deployments!.everclear;
      
      // Verify the spender address is properly set
      if (!spender) {
        throw new Error(`Everclear contract address not found for chain ID: ${chainId}`);
      }
      
      const amount = intent.amount.toString();

      // Get the Permit2 signature and request transaction data
      try {
        const signature = await getPermit2Signature(
          web3Signer,
          parseInt(chainId),
          tokenAddress,
          spender,
          amount,
          intentNonce, // Use the unique nonce
          deadline,
          config,
        );

        // Ensure nonce has 0x prefix when sending to the API
        let nonceForApi = intentNonce; // Use the unique nonce
        if (typeof intentNonce === 'string' && !intentNonce.startsWith('0x')) {
          nonceForApi = '0x' + intentNonce;
        }

        // Add to used nonces set to track uniqueness
        usedNonces.add(nonceForApi);
        
        // Log what was signed vs what's being sent to the API
        console.log(`------------Intent ${i + 1} Permit2 params:`, {
          signedWith: {
            nonce: intentNonce,
            token: tokenAddress,
            spender: spender,
            amount: amount,
            deadline: deadline
          },
          sendingToApi: {
            nonce: nonceForApi,
            deadline: deadline.toString(),
            signature: signature
          }
        });

        // Add Permit2 parameters to the intent
        const intentWithPermit = {
          ...intent,
          permit2Params: {
            nonce: nonceForApi,
            deadline: deadline.toString(),
            signature,
          },
        };

        // Fetch transaction data for Permit2-enabled newIntent
        const txData = await everclear.createNewIntent(intentWithPermit);

        // Log details of the transaction data for debugging
        console.log(`------------Intent ${txs.length + 1} txData:`, {
          to: txData.to,
          dataPrefix: txData.data,
          dataLength: txData.data.length,
          value: txData.value || '0',
          tokenAddress,
          amount
        });

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
    const multicallTx = prepareMulticall(txs, false, chainId, config);

    logger.info('Preparing to submit multicall transaction', {
      to: multicallTx.to,
      chainId,
      combinedIntentId,
    });

    // Log transaction data for debugging
    logger.info('Multicall transaction details', {
      to: multicallTx.to,
      data: multicallTx.data,
      dataLength: multicallTx.data.length,
      value: '0',
    });

    const receipt = await chainService.submitAndMonitor(chainId.toString(), {
      to: multicallTx.to,
      data: multicallTx.data,
      value: '0',
    });

    // Extract individual intent IDs from transaction logs
    const intentEvents = receipt.logs.filter((log) => log.topics[0].toLowerCase() === INTENT_ADDED_TOPIC0);
    const individualIntentIds = intentEvents.map((event) => event.topics[1]);

    logger.info('Multicall transaction confirmed', {
      transactionHash: receipt.transactionHash,
      chainId,
      combinedIntentId,
      individualIntentIds,
    });

    // Log each individual intent ID for DD searching
    individualIntentIds.forEach((intentId, index) => {
      logger.info('Individual intent created via multicall', {
        transactionHash: receipt.transactionHash,
        chainId,
        intentId,
        intentIndex: index,
        totalIntents: individualIntentIds.length,
      });
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
    // Log detailed error information
    console.error('------------Multicall transaction submission failed:', error);
    throw error;
  }
};
