import {
  MarkConfiguration,
  Invoice,
  InvalidPurchaseReasonVerbose,
  InvalidPurchaseReasons,
  DEFAULT_INVOICE_AGE,
} from '@mark/core';
import { getTickers } from '../helpers';

export function isValidInvoice(
  invoice: Invoice,
  config: MarkConfiguration,
  currentTime: number,
): InvalidPurchaseReasonVerbose | undefined {
  // Check formatting of invoice // TODO: ajv?
  try {
    BigInt(invoice?.amount ?? '0');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (_) {
    return InvalidPurchaseReasons.InvalidAmount;
  }
  const validFormat =
    invoice &&
    typeof invoice?.intent_id === 'string' &&
    typeof invoice?.amount === 'string' &&
    BigInt(invoice?.amount) > 0;
  if (!validFormat) {
    return InvalidPurchaseReasons.InvalidFormat;
  }

  // Check it is not our invoice
  if (invoice.owner.toLowerCase() === config.ownAddress.toLowerCase()) {
    return InvalidPurchaseReasons.InvalidOwner;
  }

  // Check at least one destination is supported
  const matchedDest = invoice.destinations.filter((destination) =>
    config.supportedSettlementDomains.includes(+destination),
  );
  if (matchedDest.length < 1) {
    return InvalidPurchaseReasons.InvalidDestinations;
  }

  // Check that the ticker hash is supported
  const tickers = getTickers(config);
  if (!tickers.includes(invoice.ticker_hash)) {
    return InvalidPurchaseReasons.InvalidTickers;
  }

  // Verify invoice is old enough to consider
  const age = currentTime - invoice.hub_invoice_enqueued_timestamp;
  const noOldDestinations = invoice.destinations.every((dest) => {
    const minAge = config.chains[dest]?.invoiceAge ?? DEFAULT_INVOICE_AGE;
    return age < minAge;
  });
  if (noOldDestinations) {
    return InvalidPurchaseReasons.InvalidAge;
  }

  // Valid invoice
  return undefined;
}
