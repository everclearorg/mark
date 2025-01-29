import { Invoice } from '@mark/everclear';
import { MarkConfiguration } from '@mark/core';
import { getTickers } from '#/helpers';

export function isValidInvoice(invoice: Invoice, config: MarkConfiguration): string | undefined {
  // Check formatting of invoice // TODO: ajv?
  try {
    BigInt(invoice?.amount ?? '0');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_) {
    return `Invalid amount: ${invoice?.amount} -- could not convert to BigInt`;
  }
  const validFormat =
    invoice &&
    typeof invoice?.intent_id === 'string' &&
    typeof invoice?.amount === 'string' &&
    BigInt(invoice?.amount) > 0;
  if (!validFormat) {
    return `Invalid invoice format: amount (${invoice?.amount}), invoice presence (${!!invoice}), or id (${invoice?.intent_id})`;
  }

  // Check it is not our invoice
  if (invoice.owner.toLowerCase() === config.ownAddress.toLowerCase()) {
    return `This is our invoice (owner: ${invoice.owner}, us: ${config.ownAddress})`;
  }

  // Check at least one destination is supported
  const matchedDest = invoice.destinations.filter((destination) =>
    config.supportedSettlementDomains.includes(+destination),
  );
  if (matchedDest.length < 1) {
    return `No matched destinations. Invoice: ${invoice.destinations}, configured: ${config.supportedSettlementDomains}`;
  }

  // Check that the ticker hash is supported
  const tickers = getTickers(config);
  if (!tickers.includes(invoice.ticker_hash)) {
    return `No matched tickers. Invoice: ${invoice.ticker_hash}, supported: ${tickers}`;
  }

  // Valid invoice
  return undefined;
}
