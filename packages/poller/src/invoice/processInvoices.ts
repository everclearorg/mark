import { Logger } from '../../../adapters/logger/src';
import { EverclearAdapter } from '../../../adapters/everclear/src';
import { ChainService } from '../../../adapters/chainservice/src';
import { findBestDestination } from '../helpers/selectDestination';
import { markHighestLiquidityBalance } from '../helpers/balance';
import { MarkConfiguration, NewIntentParams, TransactionRequest } from '@mark/core';

export interface ProcessInvoicesConfig {
  batchSize: number;
  chains: string[];
}

export interface Invoice {
  amount: number;
  chainId: string;
  id: string;
  owner: string;
  destinations: string[];
  ticker_hash: string;
}

export interface ProcessInvoicesDependencies {
  everclear: EverclearAdapter;
  chainService: ChainService;
  logger: Logger;
}

export interface ProcessInvoicesResult {
  processed: number;
  failed: number;
  skipped: number;
}

export async function processInvoice(
  invoice: Invoice,
  deps: ProcessInvoicesDependencies,
  config: MarkConfiguration,
  getTokenAddress: (tickerHash: string, origin: string) => Promise<string> | string,
): Promise<boolean> {
  const { everclear, chainService, logger } = deps;

  try {
    const tickerHash = invoice.ticker_hash;
    const origin = (
      await markHighestLiquidityBalance(tickerHash, invoice.destinations, config, getTokenAddress)
    ).toString();

    const selectedDestination = (await findBestDestination(origin, tickerHash, config)).toString();

    const inputAsset = await getTokenAddress(tickerHash, origin);

    const params: NewIntentParams = {
      origin,
      destinations: [selectedDestination],
      to: config.ownAddress,
      inputAsset: inputAsset,
      amount: invoice.amount,
      callData: '0x',
      maxFee: '0',
    };

    const transaction: TransactionRequest = await everclear.createNewIntent(params);

    const tx = await chainService.submitAndMonitor(transaction.chainId.toString(), {
      data: transaction.data,
    });

    logger.info('Invoice processed successfully', {
      invoiceId: invoice.id,
      txHash: tx,
    });

    return true;
  } catch (error) {
    logger.error('Failed to process invoice', {
      invoiceId: invoice.id,
      error,
    });
    return false;
  }
}

export function isValidInvoice(invoice: Invoice): boolean {
  if (!invoice) {
    return false;
  }
  return (
    invoice &&
    typeof invoice.id === 'string' &&
    typeof invoice.amount === 'number' &&
    invoice.amount > 0 &&
    invoice.owner !== 'Mark wallet address'
  );
}
