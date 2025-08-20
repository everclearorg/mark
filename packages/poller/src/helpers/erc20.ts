import { encodeFunctionData, erc20Abi, decodeAbiParameters } from 'viem';
import { MarkConfiguration, LoggingContext, WalletConfig, isTvmChain } from '@mark/core';
import { ChainService } from '@mark/chainservice';
import { Logger } from '@mark/logger';
import { TransactionReason } from '@mark/prometheus';
import { PrometheusAdapter } from '@mark/prometheus';
import { TronWeb } from 'tronweb';
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
  chainService: ChainService,
  chainId: string,
  tokenAddress: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  const encodedAllowance = await chainService.readTx({
    to: tokenAddress,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'allowance',
      args: [
        isTvmChain(chainId) ? `0x${TronWeb.address.toHex(owner).slice(2)}` : (owner as `0x${string}`),
        isTvmChain(chainId) ? `0x${TronWeb.address.toHex(spender).slice(2)}` : (spender as `0x${string}`),
      ],
    }),
    domain: +chainId,
    funcSig: 'allowance(address,address)',
  });

  const [allowance] = decodeAbiParameters(
    [{ type: 'uint256', name: 'allowance' }],
    encodedAllowance as `0x${string}`,
  ) as [bigint];

  return allowance;
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
  const currentAllowance = await checkTokenAllowance(chainService, chainId, tokenAddress, owner, spenderAddress);

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
          args: [
            isTvmChain(chainId)
              ? `0x${TronWeb.address.toHex(spenderAddress).slice(2)}`
              : (spenderAddress as `0x${string}`),
            0n,
          ],
        }),
        value: '0',
        from: config.ownAddress,
        funcSig: 'approve(address,uint256)',
      },
      zodiacConfig,
      context: { ...context, transactionType: 'zero-approval', asset: tokenAddress },
    });

    if (
      prometheus &&
      zeroApprovalResult.receipt &&
      zeroApprovalResult.receipt.cumulativeGasUsed &&
      zeroApprovalResult.receipt.effectiveGasPrice
    ) {
      prometheus.updateGasSpent(
        chainId,
        TransactionReason.Approval,
        BigInt(zeroApprovalResult.receipt.cumulativeGasUsed.toString()) *
          BigInt(zeroApprovalResult.receipt.effectiveGasPrice.toString()),
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
        args: [
          isTvmChain(chainId)
            ? `0x${TronWeb.address.toHex(spenderAddress).slice(2)}`
            : (spenderAddress as `0x${string}`),
          amount,
        ],
      }),
      value: '0',
      from: config.ownAddress,
      funcSig: 'approve(address,uint256)',
    },
    zodiacConfig,
    context: { ...context, transactionType: 'approval', asset: tokenAddress },
  });

  if (prometheus && approvalResult.receipt) {
    prometheus.updateGasSpent(
      chainId,
      TransactionReason.Approval,
      BigInt(approvalResult.receipt.cumulativeGasUsed.toString()) *
        BigInt(approvalResult.receipt.effectiveGasPrice.toString()),
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
