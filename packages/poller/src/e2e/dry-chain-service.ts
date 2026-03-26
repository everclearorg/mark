import { ChainService, SolanaSigner, SolanaTransactionResult } from '@mark/chainservice';
import type { TransactionReceipt } from '@mark/database';
import { SupportedBridge } from '@mark/core';
import { Logger } from '@mark/logger';

export interface DryRunCounter {
  count: number;
}

export function createDryRunChainService(real: ChainService, logger: Logger, counter: DryRunCounter): ChainService {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'submitAndMonitor') {
        return async (
          chainId: string,
          transaction: { to?: string; value?: bigint; funcSig?: string; data?: string },
        ) => {
          counter.count++;
          logger.info('[DRY RUN] Would submit EVM transaction', {
            chainId,
            to: transaction.to,
            value: transaction.value?.toString(),
            funcSig: transaction.funcSig,
            data: transaction.data?.substring(0, 10),
          });
          // Return synthetic receipt matching TransactionReceipt interface
          const receipt: TransactionReceipt = {
            transactionHash: `0xdryrun_${Date.now()}_${chainId}`,
            from: '',
            to: transaction.to || '',
            blockNumber: 0,
            cumulativeGasUsed: '0',
            effectiveGasPrice: '0',
            logs: [],
            status: 1,
            confirmations: 0,
          };
          return receipt;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function createDryRunSolanaSigner(real: SolanaSigner, logger: Logger, counter: DryRunCounter): SolanaSigner {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'signAndSendTransaction') {
        return async () => {
          counter.count++;
          logger.info('[DRY RUN] Would submit Solana transaction');
          const result: SolanaTransactionResult = {
            signature: `dryrun_sol_${Date.now()}`,
            slot: 0,
            blockTime: Math.floor(Date.now() / 1000),
            success: true,
            fee: 0,
            logs: ['[DRY RUN] Transaction intercepted'],
          };
          return result;
        };
      }
      if (prop === 'sendSignedTransaction') {
        return async () => {
          counter.count++;
          logger.info('[DRY RUN] Would send pre-signed Solana transaction');
          const result: SolanaTransactionResult = {
            signature: `dryrun_sol_signed_${Date.now()}`,
            slot: 0,
            blockTime: Math.floor(Date.now() / 1000),
            success: true,
            fee: 0,
            logs: ['[DRY RUN] Signed transaction intercepted'],
          };
          return result;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createDryRunRebalanceAdapter(real: any, logger: Logger, counter: DryRunCounter): any {
  return new Proxy(real, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get(target: any, prop: string | symbol, _receiver: any) {
      if (prop === 'getAdapter') {
        return (type: SupportedBridge) => {
          const adapter = target.getAdapter(type);
          // Wrap CCIP adapter to intercept sendSolanaToMainnet
          if (type === SupportedBridge.CCIP) {
            return new Proxy(adapter, {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              get(adapterTarget: any, adapterProp: string | symbol, _adapterReceiver: any) {
                if (adapterProp === 'sendSolanaToMainnet') {
                  return async (sender: string, recipient: string, amount: string) => {
                    counter.count++;
                    logger.info('[DRY RUN] Would send Solana→Mainnet CCIP bridge', {
                      sender,
                      recipient,
                      amount,
                    });
                    return {
                      hash: `dryrun_ccip_sol_${Date.now()}`,
                      logs: ['[DRY RUN] CCIP bridge intercepted'],
                      blockNumber: 0,
                      timestamp: Math.floor(Date.now() / 1000),
                      from: sender,
                    };
                  };
                }
                return Reflect.get(adapterTarget, adapterProp, _adapterReceiver);
              },
            });
          }
          return adapter;
        };
      }
      return Reflect.get(target, prop, _receiver);
    },
  });
}
