import { Invoice } from '@mark/everclear';
import { MarkConfiguration } from '@mark/core';

// TODO - add logging for why invoices are skipped
export function isValidInvoice(invoice: Invoice, config: MarkConfiguration): boolean {
  // Check formatting of invoice // TODO: ajv?
  const validFormat =
    invoice &&
    typeof invoice.intent_id === 'string' &&
    typeof invoice.amount === 'string' &&
    BigInt(invoice.amount) > 0;
  if (!validFormat) {
    console.log('!validFormat');
    return false;
  }

  // Check it is not our invoice
  if (invoice.owner.toLowerCase() === config.web3SignerUrl.toLowerCase()) {
    console.log('!owner');
    return false;
  }

  // Check that it is old enough
  const time = Math.floor(Date.now() / 1000);
  if (time - config.invoiceAge < invoice.hub_invoice_enqueued_timestamp) {
    console.log('!old', time - config.invoiceAge, invoice.hub_invoice_enqueued_timestamp);
    return false;
  }

  // Check at least one destination is supported
  const matchedDest = invoice.destinations.filter((destination) =>
    config.supportedSettlementDomains.includes(+destination),
  );
  if (matchedDest.length < 1) {
    console.log('!dest');
    return false;
  }

  // Check that the ticker hash is supported
  const tickers = Object.values(config.chains)
    .map((c) => c.assets)
    .map((c) => c.map((a) => a.tickerHash.toLowerCase()))
    .flat();
  if (!tickers.includes(invoice.ticker_hash)) {
    console.log('!tickers');
    return false;
  }

  // Valid invoice
  return true;
}
