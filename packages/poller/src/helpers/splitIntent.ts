import { getTokenAddressFromConfig, Invoice, NewIntentParams } from '@mark/core';
import { jsonifyMap } from '@mark/logger';
import { convertHubAmountToLocalDecimals } from './asset';
import { MAX_DESTINATIONS, TOP_N_DESTINATIONS } from '../invoice/processInvoices';
import { ProcessingContext } from '../init';
import { getValidatedZodiacConfig, WalletType } from './zodiac';

interface SplitIntentAllocation {
  origin: string;
  allocations: { domain: string; amount: bigint }[];
  totalAllocated: bigint;
  destinations: string[];
  isTopN: boolean;
}

interface SplitIntentResult {
  intents: NewIntentParams[];
  originDomain: string;
  originNeeded: bigint;
  totalAllocated: bigint;
  remainder: bigint;
}

/**
 * Evaluates a domain as a potential origin for split intents
 */
function evaluateDomainForOrigin(
  origin: string,
  requiredAmount: bigint,
  custodiedAssets: Map<string, bigint>,
  domainCandidates: string[],
  isTopN: boolean,
): SplitIntentAllocation {
  const allocation: SplitIntentAllocation = {
    origin,
    allocations: [],
    totalAllocated: BigInt(0),
    destinations: [],
    isTopN,
  };

  // Go through domain candidates in order
  for (const domain of domainCandidates) {
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
    allocation.destinations.push(domain);

    // If we've allocated enough, break out of the loop
    if (allocation.totalAllocated >= requiredAmount) break;
  }

  return allocation;
}

/**
 * Calculates split intents for an invoice
 */
export async function calculateSplitIntents(
  context: ProcessingContext,
  invoice: Invoice,
  minAmounts: Record<string, string>,
  balances: Map<string, Map<string, bigint>>,
  custodiedAssets: Map<string, Map<string, bigint>>,
): Promise<SplitIntentResult> {
  const { config, logger, requestId } = context;
  const ticker = invoice.ticker_hash;
  const allCustodiedAssets = custodiedAssets.get(ticker) || new Map<string, bigint>();
  const configDomains = config.supportedSettlementDomains.map((d) => d.toString());

  // Filter for domains that support the given asset, maintaining the
  // original config order
  const assetSupportedDomains = configDomains.filter((domain) => {
    const chainConfig = config.chains[domain];
    if (!chainConfig) return false;
    const tickers = chainConfig.assets.map((a) => a.tickerHash.toLowerCase());
    return tickers.includes(invoice.ticker_hash.toLowerCase());
  });
  logger.info('Got supported domains to evaluate', {
    requestId,
    invoiceId: invoice.intent_id,
    assetSupportedDomains,
    minAmounts,
    balances: jsonifyMap(balances),
    custodiedAssets: jsonifyMap(custodiedAssets),
  });

  // Sort the top-N domains by custodied assets
  const topNDomainsFromConfig = assetSupportedDomains.slice(0, TOP_N_DESTINATIONS);
  const topNDomainsSortedByCustodied = [...topNDomainsFromConfig].sort((a, b) => {
    const aAssets = allCustodiedAssets.get(a) ?? BigInt(0);
    const bAssets = allCustodiedAssets.get(b) ?? BigInt(0);
    return Number(bAssets - aAssets); // Sort descending
  });

  // Sort all domains by custodied assets
  const allDomainsSortedByCustodied = [...assetSupportedDomains].sort((a, b) => {
    const aAssets = allCustodiedAssets.get(a) ?? BigInt(0);
    const bAssets = allCustodiedAssets.get(b) ?? BigInt(0);
    return Number(bAssets - aAssets); // Sort descending
  });

  // Evaluate each possible origin domain
  const possibleAllocations: SplitIntentAllocation[] = [];
  for (const origin of Object.keys(minAmounts)) {
    const totalNeeded = BigInt(minAmounts[origin]);

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

    // Try allocating with top-N domains
    const topNAllocation = evaluateDomainForOrigin(
      origin,
      totalNeeded,
      allCustodiedAssets,
      topNDomainsSortedByCustodied,
      true,
    );
    logger.info('Evaluated top-N domains for invoice', {
      requestId,
      invoiceId: invoice.intent_id,
      origin,
      totalNeeded,
      topNAllocation,
      topNDomainsSortedByCustodied,
      allCustodiedAssets: jsonifyMap(allCustodiedAssets),
    });

    if (topNAllocation.totalAllocated >= totalNeeded) {
      possibleAllocations.push(topNAllocation);
      logger.debug('Allocating amongst top-N domains', {
        requestId,
        invoiceId: invoice.intent_id,
      });
      continue;
    }

    // If top-N is not enough, try with the top MAX_DESTINATIONS domains
    // NOTE: This is unconditionally added as a possible allocation. This is deliberate
    //       because Mark should settle the invoice regardless if liquidity can cover his intent.
    const topMaxDestinations = allDomainsSortedByCustodied.slice(0, MAX_DESTINATIONS);
    const topMaxAllocation = evaluateDomainForOrigin(
      origin,
      totalNeeded,
      allCustodiedAssets,
      topMaxDestinations,
      false,
    );
    logger.info('Evaluated top-MAX domains for invoice', {
      requestId,
      invoiceId: invoice.intent_id,
      origin,
      totalNeeded,
      topMaxAllocation,
      allCustodiedAssets: jsonifyMap(allCustodiedAssets),
    });

    possibleAllocations.push(topMaxAllocation);
  }

  // If no allocations found, return empty result
  // This means there were no origins where Mark had enough balance
  if (possibleAllocations.length === 0) {
    logger.info('No origins where Mark had enough balance', {
      requestId,
      invoiceId: invoice.intent_id,
      ticker,
    });
    return { intents: [], originDomain: '', originNeeded: BigInt(0), totalAllocated: BigInt(0), remainder: BigInt(0) };
  }

  // Find the best allocation:
  // 1. Prefer top-N allocations
  // 2. Then prefer fewer allocations
  // 3. Lastly, consider total allocated amount as a tiebreaker
  possibleAllocations.sort((a, b) => {
    // 1. Prefer top-N allocations (these are only added as possible allocations
    //   if they fully cover the amount needed)
    const aUsesOnlyTopN = a.isTopN;
    const bUsesOnlyTopN = b.isTopN;

    if (aUsesOnlyTopN !== bUsesOnlyTopN) {
      return aUsesOnlyTopN ? -1 : 1;
    }

    // 2. Sort by number of allocations (fewer is better)
    if (a.allocations.length !== b.allocations.length) {
      return a.allocations.length - b.allocations.length;
    }

    // 3. Use totalAllocated as a tiebreaker (higher is better)
    if (b.totalAllocated > a.totalAllocated) return 1;
    if (b.totalAllocated < a.totalAllocated) return -1;
    return 0;
  });
  const bestAllocation = possibleAllocations[0];
  const totalNeeded = BigInt(minAmounts[bestAllocation.origin]);

  logger.info('Best allocation found for split intent', {
    requestId,
    invoiceId: invoice.intent_id,
    origin: bestAllocation.origin,
    totalAllocated: bestAllocation.totalAllocated.toString(),
    needed: totalNeeded.toString(),
    coverage: `${((Number(bestAllocation.totalAllocated) * 100) / Number(totalNeeded)).toFixed(2)}%`,
    allocationCount: bestAllocation.allocations.length,
    isTopN: bestAllocation.isTopN,
  });

  // Generate the intent parameters for each allocation
  const intents: NewIntentParams[] = [];

  const inputAsset = getTokenAddressFromConfig(ticker, bestAllocation.origin, config);
  if (!inputAsset) {
    throw new Error('No input asset found');
  }

  // Create intents for the targeted allocations
  for (const { domain, amount } of bestAllocation.allocations) {
    if (amount <= BigInt(0)) continue;

    // Get Zodiac configuration for the destination chain to determine correct 'to' address
    const destinationChainConfig = config.chains[domain];
    const destinationZodiacConfig = getValidatedZodiacConfig(destinationChainConfig);
    const toAddress =
      destinationZodiacConfig.walletType !== WalletType.EOA ? destinationZodiacConfig.safeAddress! : config.ownAddress;

    const params: NewIntentParams = {
      origin: bestAllocation.origin,
      destinations: [domain], // Use only the specific target domain for this allocation
      to: toAddress,
      inputAsset,
      amount: convertHubAmountToLocalDecimals(amount, inputAsset, bestAllocation.origin, config).toString(),
      callData: '0x',
      maxFee: '0',
    };
    intents.push(params);
  }

  // If allocation doesn't fully cover the amount, split remainder into smaller intents
  const remainder = totalNeeded - bestAllocation.totalAllocated;
  if (remainder > BigInt(0)) {
    // Split remainder: create separate intents for each valid top-N chain
    const validTopNDomains = topNDomainsFromConfig.filter((domain) => domain !== bestAllocation.origin);
    if (validTopNDomains.length > 0) {
      const splitAmount = remainder / BigInt(validTopNDomains.length);
      const dust = remainder % BigInt(validTopNDomains.length);

      for (let i = 0; i < validTopNDomains.length; i++) {
        const targetDomain = validTopNDomains[i];
        const amountForThisSplit = i === validTopNDomains.length - 1 ? splitAmount + dust : splitAmount; // Add dust to the last one

        if (amountForThisSplit <= BigInt(0)) continue;

        // Get Zodiac configuration for the destination chain to determine correct 'to' address
        const destinationChainConfig = config.chains[targetDomain];
        const destinationZodiacConfig = getValidatedZodiacConfig(destinationChainConfig);
        const toAddress =
          destinationZodiacConfig.walletType !== WalletType.EOA
            ? destinationZodiacConfig.safeAddress!
            : config.ownAddress;

        const params: NewIntentParams = {
          origin: bestAllocation.origin,
          destinations: [targetDomain], // Use only the target domain
          to: toAddress,
          inputAsset,
          amount: convertHubAmountToLocalDecimals(
            amountForThisSplit,
            inputAsset,
            bestAllocation.origin,
            config,
          ).toString(),
          callData: '0x',
          maxFee: '0',
        };
        intents.push(params);
      }

      logger.info('Added remainder intents to allocation', {
        requestId,
        invoiceId: invoice.intent_id,
        remainder: remainder.toString(),
        intentCount: validTopNDomains.length,
      });
    }
  }

  return {
    intents,
    originDomain: bestAllocation.origin,
    originNeeded: totalNeeded,
    totalAllocated: bestAllocation.totalAllocated,
    remainder: remainder,
  };
}
