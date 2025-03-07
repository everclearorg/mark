import { getTokenAddressFromConfig, Invoice, MarkConfiguration, NewIntentParams } from '@mark/core';
import { Logger } from '@mark/logger';
import { EverclearAdapter } from '@mark/everclear';
import { convertHubAmountToLocalDecimals } from './asset';
import { MAX_DESTINATIONS } from '../invoice/processInvoices';
import { getCustodiedBalances } from './balance';

interface SplitIntentAllocation {
  origin: string;
  allocations: { domain: string; amount: bigint }[];
  totalAllocated: bigint;
}

interface SplitIntentResult {
  intents: NewIntentParams[];
  originDomain: string;
  totalAllocated: bigint;
}

/**
 * Evaluates a domain as a potential origin for split intents
 */
function evaluateDomainForOrigin(
  origin: string,
  requiredAmount: bigint,
  custodiedAssets: Map<string, bigint>,
  configDomains: string[],
): SplitIntentAllocation {
  const allocation: SplitIntentAllocation = {
    origin,
    allocations: [],
    totalAllocated: BigInt(0),
  };

  // Go through config domains in order
  for (const domain of configDomains) {
    // Skip the origin domain - can't use as a destination
    if (domain === origin) continue;

    const available = custodiedAssets.get(domain) ?? BigInt(0);
    if (available <= 0) continue;

    // Calculate how much to use from this domain
    const remaining = requiredAmount - allocation.totalAllocated;
    if (remaining <= 0) break;

    const amountToAllocate = available < remaining ? available : remaining;

    // TODO: min allocation size?

    allocation.allocations.push({
      domain,
      amount: amountToAllocate,
    });

    allocation.totalAllocated += amountToAllocate;

    // If we've allocated enough, break out of the loop
    if (allocation.totalAllocated >= requiredAmount) break;
  }

  return allocation;
}

/**
 * Calculates split intents for an invoice
 */
export async function calculateSplitIntents(
  invoice: Invoice,
  minAmounts: Record<string, string>,
  config: MarkConfiguration,
  balances: Map<string, Map<string, bigint>>,
  logger: Logger,
): Promise<SplitIntentResult> {
  const ticker = invoice.ticker_hash;
  const totalNeeded = BigInt(invoice.amount);

  // Get all domains from config
  const configDomains = config.supportedSettlementDomains.map((d) => d.toString());

  const custodiedBalances = await getCustodiedBalances(config);
  const allCustodiedAssets = custodiedBalances.get(ticker) || new Map<string, bigint>();

  // Evaluate each possible origin domain
  const possibleAllocations: SplitIntentAllocation[] = [];

  // First, try the invoice destinations as origins
  for (const origin of Object.keys(minAmounts)) {
    // Check if Mark has balance on this origin
    const markOriginBalance = balances.get(ticker)?.get(origin) ?? BigInt(0);
    if (markOriginBalance < totalNeeded) {
      logger.debug('Skipping origin due to insufficient balance', {
        origin,
        required: totalNeeded.toString(),
        available: markOriginBalance.toString(),
      });
      continue;
    }

    // Try allocating with top-N domains first
    const topNAllocation = evaluateDomainForOrigin(
      origin,
      totalNeeded,
      allCustodiedAssets,
      configDomains.slice(0, MAX_DESTINATIONS),
    );

    if (topNAllocation.totalAllocated >= totalNeeded) {
      possibleAllocations.push(topNAllocation);
      continue;
    }

    // If top-N is not enough, try with all domains
    // NOTE: This is unconditionally added as a possible allocation. This is deliberate
    //       because Mark should settle the invoice regardless if liquidity can cover his intent.
    const allDomainsAllocation = evaluateDomainForOrigin(origin, totalNeeded, allCustodiedAssets, configDomains);

    possibleAllocations.push(allDomainsAllocation);
  }

  // If no allocations found, return empty result
  // This means there were no origins where Mark had enough balance
  if (possibleAllocations.length === 0) {
    logger.info('No origins where Mark had enough balance', {
      invoice: invoice.intent_id,
      ticker,
    });
    return { intents: [], originDomain: '', totalAllocated: BigInt(0) };
  }

  // Find the best allocation (one that covers the most)
  possibleAllocations.sort((a, b) => Number(b.totalAllocated - a.totalAllocated));
  const bestAllocation = possibleAllocations[0];

  logger.info('Best allocation found for split intent', {
    invoice: invoice.intent_id,
    origin: bestAllocation.origin,
    totalAllocated: bestAllocation.totalAllocated.toString(),
    needed: totalNeeded.toString(),
    coverage: `${((Number(bestAllocation.totalAllocated) * 100) / Number(totalNeeded)).toFixed(2)}%`,
    allocationCount: bestAllocation.allocations.length,
  });

  // Generate the intent parameters for each allocation
  const intents: NewIntentParams[] = [];

  // Generate destinations array (excluding origin, limited to MAX_DESTINATIONS)
  const destinations = configDomains.filter((d) => d !== bestAllocation.origin).slice(0, MAX_DESTINATIONS);

  // Create an intent for each allocation
  for (const { domain, amount } of bestAllocation.allocations) {
    const inputAsset = getTokenAddressFromConfig(ticker, bestAllocation.origin, config);
    if (!inputAsset) {
      logger.error('No input asset found', {
        ticker,
        origin: bestAllocation.origin,
        domain,
        config: Object.keys(config.chains || {}).length,
      });
      continue;
    }

    const params: NewIntentParams = {
      origin: bestAllocation.origin,
      destinations: destinations,
      to: config.ownAddress,
      inputAsset,
      amount: convertHubAmountToLocalDecimals(amount, inputAsset, bestAllocation.origin, config).toString(),
      callData: '0x',
      maxFee: '0',
    };

    intents.push(params);
  }

  return {
    intents,
    originDomain: bestAllocation.origin,
    totalAllocated: bestAllocation.totalAllocated,
  };
}
