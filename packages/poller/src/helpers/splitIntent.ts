import { getTokenAddressFromConfig, Invoice, MarkConfiguration, NewIntentParams } from '@mark/core';
import { jsonifyMap, Logger } from '@mark/logger';
import { convertHubAmountToLocalDecimals } from './asset';
import { MAX_DESTINATIONS, TOP_N_DESTINATIONS } from '../invoice/processInvoices';

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
  custodiedAssets: Map<string, Map<string, bigint>>,
  logger: Logger,
  requestId?: string,
): Promise<SplitIntentResult> {
  const ticker = invoice.ticker_hash;
  const totalNeeded = BigInt(invoice.amount);

  // Get all domains from config
  const configDomains = config.supportedSettlementDomains.map((d) => d.toString());

  // Get all the domains from config that support the given asset
  const assetSupportedDomains = Object.entries(config.chains)
    .filter(([domain, chainConfig]) => {
      const tickers = chainConfig.assets.map((a) => a.tickerHash.toLowerCase());
      return configDomains.includes(domain) && tickers.includes(invoice.ticker_hash.toLowerCase());
    })
    .map(([domain]) => domain.toString());
  logger.info('Got supported domains to evaluate', {
    requestId,
    invoiceId: invoice.intent_id,
  });

  const allCustodiedAssets = custodiedAssets.get(ticker) || new Map<string, bigint>();

  // Evaluate each possible origin domain
  const possibleAllocations: SplitIntentAllocation[] = [];

  // First, try the invoice destinations as origins
  for (const origin of Object.keys(minAmounts)) {
    // Check if Mark has balance on this origin
    const markOriginBalance = balances.get(ticker)?.get(origin) ?? BigInt(0);
    if (markOriginBalance < totalNeeded) {
      logger.debug('Skipping origin due to insufficient balance', {
        requestId,
        invoiceId: invoice.intent_id,
        origin,
        required: totalNeeded.toString(),
        available: markOriginBalance.toString(),
      });
      continue;
    }

    // Sort domains by custodied assets (highest first)
    const sortedConfigDomains = [...assetSupportedDomains].sort((a, b) => {
      const aAssets = allCustodiedAssets.get(a) ?? BigInt(0);
      const bAssets = allCustodiedAssets.get(b) ?? BigInt(0);
      return Number(bAssets - aAssets); // Sort descending
    });

    // Define top-N domains (sorted by custodied assets)
    const topNDomains = sortedConfigDomains.slice(0, TOP_N_DESTINATIONS);
    logger.info('Selected top domains for invoice', {
      requestId,
      invoiceId: invoice.intent_id,
      topNDomains,
      allCustodiedAssets: jsonifyMap(allCustodiedAssets),
    });

    // Try allocating with top-N domains first
    const topNAllocation = evaluateDomainForOrigin(origin, totalNeeded, allCustodiedAssets, topNDomains);
    logger.info('Evaluated top allocations for invoice from origin', {
      requestId,
      invoiceId: invoice.intent_id,
      origin,
      totalNeeded,
      topNAllocation,
      allCustodiedAssets: jsonifyMap(allCustodiedAssets),
    });

    if (topNAllocation.totalAllocated >= totalNeeded) {
      possibleAllocations.push(topNAllocation);
      continue;
    }

    // If top-N is not enough, try with all domains (limited to MAX_DESTINATIONS)
    // NOTE: This is unconditionally added as a possible allocation. This is deliberate
    //       because Mark should settle the invoice regardless if liquidity can cover his intent.
    const allDomainsAllocation = evaluateDomainForOrigin(
      origin,
      totalNeeded,
      allCustodiedAssets,
      sortedConfigDomains.slice(0, MAX_DESTINATIONS),
    );
    logger.info('Evaluated all domains for invoice from origin', {
      requestId,
      invoiceId: invoice.intent_id,
      origin,
      totalNeeded,
      allDomainsAllocation,
      allCustodiedAssets: jsonifyMap(allCustodiedAssets),
    });

    possibleAllocations.push(allDomainsAllocation);
  }

  // If no allocations found, return empty result
  // This means there were no origins where Mark had enough balance
  if (possibleAllocations.length === 0) {
    logger.info('No origins where Mark had enough balance', {
      requestId,
      invoiceId: invoice.intent_id,
      ticker,
    });
    return { intents: [], originDomain: '', totalAllocated: BigInt(0) };
  }

  // Find the best allocation:
  // 1. Prefer allocations with fewer intents (allocations)
  // 2. For the same number of intents, prefer allocations that only use top-N chains
  // 3. Lastly, consider total allocated amount as a tiebreaker
  possibleAllocations.sort((a, b) => {
    // 1. Sort by number of allocations (fewer is better)
    if (a.allocations.length !== b.allocations.length) {
      return a.allocations.length - b.allocations.length;
    }

    // 2. Prefer allocations that only use top-N chains
    const topNDomains = assetSupportedDomains.slice(0, TOP_N_DESTINATIONS);
    const aUsesOnlyTopN = a.allocations.every((alloc) => topNDomains.includes(alloc.domain));
    const bUsesOnlyTopN = b.allocations.every((alloc) => topNDomains.includes(alloc.domain));

    if (aUsesOnlyTopN !== bUsesOnlyTopN) {
      return aUsesOnlyTopN ? -1 : 1;
    }

    // 3. Use totalAllocated as a tiebreaker (higher is better)
    if (b.totalAllocated > a.totalAllocated) return 1;
    if (b.totalAllocated < a.totalAllocated) return -1;
    return 0;
  });
  const bestAllocation = possibleAllocations[0];

  logger.info('Best allocation found for split intent', {
    requestId,
    invoiceId: invoice.intent_id,
    origin: bestAllocation.origin,
    totalAllocated: bestAllocation.totalAllocated.toString(),
    needed: totalNeeded.toString(),
    coverage: `${((Number(bestAllocation.totalAllocated) * 100) / Number(totalNeeded)).toFixed(2)}%`,
    allocationCount: bestAllocation.allocations.length,
  });

  // Generate the intent parameters for each allocation
  const intents: NewIntentParams[] = [];

  // Generate destinations array (excluding origin, limited to MAX_DESTINATIONS)
  const destinations = assetSupportedDomains.filter((d) => d !== bestAllocation.origin).slice(0, MAX_DESTINATIONS);

  // Create an intent for each allocation
  for (const { domain, amount } of bestAllocation.allocations) {
    const inputAsset = getTokenAddressFromConfig(ticker, bestAllocation.origin, config);
    if (!inputAsset) {
      logger.error('No input asset found', {
        requestId,
        invoiceId: invoice.intent_id,
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
