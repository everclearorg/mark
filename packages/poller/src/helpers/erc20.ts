import { encodeFunctionData, erc20Abi } from 'viem';
import { getERC20Contract } from './contracts';
import { MarkConfiguration, LoggingContext, WalletConfig } from '@mark/core';
import { ChainService } from '@mark/chainservice';
import { Logger } from '@mark/logger';
import { TransactionReason } from '@mark/prometheus';
import { PrometheusAdapter } from '@mark/prometheus';
import { submitTransactionWithLogging } from './transactions';

export interface ApprovalParams {
  config: MarkConfiguration;
  chainService: ChainService;
  logger: Logger;
  prometheus?: PrometheusAdapter;
  chainId: string;
  tokenAddress: string;
  spenderAddress: string;
  amount: bigint;
  owner: string;
  zodiacConfig: WalletConfig;
  context?: LoggingContext; // For logging context (requestId, invoiceId, etc.)
}

export interface ApprovalResult {
  wasRequired: boolean;
  transactionHash?: string;
  hadZeroApproval?: boolean;
  zeroApprovalTxHash?: string;
}

/**
 * Checks current allowance for a token
 */
export async function checkTokenAllowance(
  config: MarkConfiguration,
  chainId: string,
  tokenAddress: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const tokenContract = await getERC20Contract(config, chainId, tokenAddress as `0x${string}`);
  const allowance = await tokenContract.read.allowance([owner as `0x${string}`, spender as `0x${string}`]);
  return allowance as bigint;
}

/**
 * Checks if a token is USDT based on chain assets configuration
 */
export function isUSDTToken(config: MarkConfiguration, chainId: string, tokenAddress: string): boolean {
  const chainAssets = config.chains[chainId]?.assets ?? [];
  return chainAssets.some(
    (asset) => asset.symbol.toUpperCase() === 'USDT' && asset.address.toLowerCase() === tokenAddress.toLowerCase(),
  );
}

/**
 * Handles the complete ERC20 approval flow including USDT special case
 */
export async function checkAndApproveERC20(params: ApprovalParams): Promise<ApprovalResult> {
  const {
    config,
    chainService,
    logger,
    prometheus,
    chainId,
    tokenAddress,
    spenderAddress,
    amount,
    owner,
    zodiacConfig,
    context = {},
  } = params;

  const result: ApprovalResult = { wasRequired: false };

  // Check current allowance
  const currentAllowance = await checkTokenAllowance(config, chainId, tokenAddress, owner, spenderAddress);

  logger.info('Current token allowance', {
    ...context,
    spenderAddress,
    owner,
    asset: tokenAddress,
    allowance: currentAllowance.toString(),
    requiredAmount: amount.toString(),
  });

  // If allowance is sufficient, no approval needed
  if (currentAllowance >= amount) {
    logger.info('Sufficient allowance already available', {
      ...context,
      allowance: currentAllowance.toString(),
      asset: tokenAddress,
      amount: amount.toString(),
    });
    return result;
  }

  result.wasRequired = true;

  // Check if this is USDT and handle the zero-approval requirement
  const isUSdt = isUSDTToken(config, chainId, tokenAddress);

  if (isUSdt && currentAllowance > 0n) {
    logger.info('USDT allowance is greater than zero, setting allowance to zero first', {
      ...context,
      allowance: currentAllowance.toString(),
      spender: spenderAddress,
    });

    const zeroApprovalResult = await submitTransactionWithLogging({
      chainService,
      logger,
      chainId,
      txRequest: {
        to: tokenAddress,
        chainId: +chainId,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [spenderAddress as `0x${string}`, 0n],
        }),
        value: '0',
        from: config.ownAddress,
      },
      zodiacConfig,
      context: { ...context, transactionType: 'zero-approval', asset: tokenAddress },
    });

    if (prometheus && zeroApprovalResult.receipt) {
      prometheus.updateGasSpent(
        chainId,
        TransactionReason.Approval,
        BigInt(
          zeroApprovalResult.receipt.cumulativeGasUsed.mul(zeroApprovalResult.receipt.effectiveGasPrice).toString(),
        ),
      );
    }

    logger.info('Zero allowance transaction for USDT sent successfully', {
      ...context,
      chainId,
      zeroAllowanceTxHash: zeroApprovalResult.hash,
      asset: tokenAddress,
    });

    result.hadZeroApproval = true;
    result.zeroApprovalTxHash = zeroApprovalResult.hash;
  }

  // Now set the actual approval
  logger.info('Setting ERC20 approval', {
    ...context,
    spender: spenderAddress,
    amount: amount.toString(),
    isUSdt,
  });

  const approvalResult = await submitTransactionWithLogging({
    chainService,
    logger,
    chainId,
    txRequest: {
      chainId: +chainId,
      to: tokenAddress,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spenderAddress as `0x${string}`, amount],
      }),
      value: '0',
      from: config.ownAddress,
    },
    zodiacConfig,
    context: { ...context, transactionType: 'approval', asset: tokenAddress },
  });

  if (prometheus && approvalResult.receipt) {
    prometheus.updateGasSpent(
      chainId,
      TransactionReason.Approval,
      BigInt(approvalResult.receipt.cumulativeGasUsed.mul(approvalResult.receipt.effectiveGasPrice).toString()),
    );
  }

  logger.info('Approval transaction sent successfully', {
    ...context,
    chainId,
    approvalTxHash: approvalResult.hash,
    allowance: currentAllowance.toString(),
    asset: tokenAddress,
    amount: amount.toString(),
  });

  result.transactionHash = approvalResult.hash;
  return result;
}
