/**
 * Debug script for diagnosing intent creation failures against the Everclear API.
 *
 * Usage:
 *   yarn workspace @mark/poller debug:intent                  # list recent invoices
 *   yarn workspace @mark/poller debug:intent <invoice_id>     # inspect a specific invoice
 *
 * Environment:
 *   EVERCLEAR_API_URL  - API base URL (default: https://api.everclear.org)
 */

import axios from 'axios';

const API_URL = process.env.EVERCLEAR_API_URL || 'https://api.everclear.org';

// ─── helpers ────────────────────────────────────────────────────────────────

function log(label: string, data: unknown): void {
  console.log(`\n── ${label} ──`);
  console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const { data } = await axios.get<T>(`${API_URL}${path}`);
    return data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      console.error(`GET ${path} → ${err.response?.status}: ${JSON.stringify(err.response?.data)}`);
    } else {
      console.error(`GET ${path} →`, (err as Error).message);
    }
    return null;
  }
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const { data } = await axios.post<T>(`${API_URL}${path}`, body);
    return data;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      log('API ERROR', {
        status: err.response?.status,
        statusText: err.response?.statusText,
        responseBody: err.response?.data,
        requestBody: body,
      });
    } else {
      console.error(`POST ${path} →`, (err as Error).message);
    }
    return null;
  }
}

// ─── commands ───────────────────────────────────────────────────────────────

async function listInvoices(): Promise<void> {
  const result = await get<{ invoices: Record<string, unknown>[] }>('/invoices?limit=10');
  if (!result?.invoices?.length) {
    console.log('No invoices found.');
    return;
  }

  console.log(`\nFound ${result.invoices.length} invoices:\n`);
  for (const inv of result.invoices) {
    console.log(
      `  ${inv.intent_id}  origin=${inv.origin}  amount=${inv.amount}  ticker=${(inv.ticker_hash as string)?.slice(0, 18)}…`,
    );
  }

  console.log(`\nRun with an invoice ID to inspect: yarn workspace @mark/poller debug:intent <id>`);
}

async function inspectInvoice(invoiceId: string): Promise<void> {
  log('Invoice ID', invoiceId);

  // 1. Fetch min amounts
  const minAmounts = await get<{
    invoiceAmount: string;
    amountAfterDiscount: string;
    discountBps: string;
    custodiedAmounts: Record<string, string>;
    minAmounts: Record<string, string>;
  }>(`/invoices/${invoiceId}/min-amounts`);

  if (!minAmounts) {
    console.log('Could not fetch min amounts. Stopping.');
    return;
  }

  log('Min Amounts', minAmounts);

  // 2. Show available origins
  const origins = Object.entries(minAmounts.minAmounts).filter(([, v]) => BigInt(v) > 0n);
  if (!origins.length) {
    console.log('No origins with minAmount > 0.');
    return;
  }

  log(
    'Available origins',
    origins.map(([chain, amt]) => `chain ${chain}: ${amt}`),
  );

  // 3. Show custodied amounts
  const custodied = Object.entries(minAmounts.custodiedAmounts).filter(([, v]) => BigInt(v) > 0n);
  log(
    'Custodied (nonzero)',
    custodied.map(([chain, amt]) => `chain ${chain}: ${amt}`),
  );

  // 4. Dry-run: try creating intent with first valid origin → first valid destination
  const [origin, amount] = origins[0];
  const destinations = custodied.map(([d]) => d).filter((d) => d !== origin);

  if (!destinations.length) {
    console.log('No valid destinations after excluding origin.');
    return;
  }

  // Build a minimal test payload — this will fail (placeholder addresses) but will
  // surface the API validation error, which is the entire point of this script.
  const testPayload = {
    origin,
    destinations: destinations.slice(0, 3),
    to: '<REPLACE_WITH_OWN_ADDRESS>',
    inputAsset: '<REPLACE_WITH_TOKEN_ADDRESS>',
    amount,
    callData: '0x',
    maxFee: '0',
  };

  log('Test payload (edit to and inputAsset before running)', testPayload);

  console.log(
    '\nTo test against the API, update `to` and `inputAsset` in the payload above ' +
      'and re-run, or use curl:\n',
  );
  console.log(`  curl -s -X POST ${API_URL}/intents \\`);
  console.log(`    -H 'Content-Type: application/json' \\`);
  console.log(`    -d '${JSON.stringify(testPayload)}' | jq .`);
  console.log();

  // Optionally try the API call anyway to see the exact validation error
  console.log('Attempting API call to surface validation error...\n');
  await post('/intents', testPayload);
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Everclear API: ${API_URL}\n`);

  const invoiceId = process.argv[2];
  if (invoiceId) {
    await inspectInvoice(invoiceId);
  } else {
    await listInvoices();
  }
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
