import { config } from 'dotenv';
import { resolve } from 'path';
import { Logger } from '@mark/logger';
import { BinanceClient } from '../src/adapters/binance/client';
import { BINANCE_NETWORK_TO_CHAIN_ID } from '../src/adapters/binance/constants';

// Load .env from project root
config({ path: resolve(__dirname, '../../../../.env') });

const logger = new Logger({ level: 'debug', service: 'binance-check' });

async function main() {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;

  if (!apiKey || !apiSecret) {
    logger.error('Missing BINANCE_API_KEY or BINANCE_API_SECRET in .env');
    process.exit(1);
  }

  logger.info('Initializing Binance client...');
  const client = new BinanceClient(apiKey, apiSecret, 'https://api.binance.com', logger);

  if (!client.isConfigured()) {
    logger.error('Binance client not properly configured');
    process.exit(1);
  }

  logger.info('=== Binance USDC Withdrawal Check ===');

  // Step 1: System status
  logger.info('Step 1: Checking Binance system status...');
  const isOperational = await client.isSystemOperational();
  logger.info('System status result', { isOperational });
  if (!isOperational) {
    logger.error('Binance system is NOT operational. Aborting.');
    process.exit(1);
  }

  // Step 2: Account balances — show all non-zero balances + highlight USDC
  logger.info('Step 2: Fetching account balances...');
  const balances = await client.getAccountBalance();
  const nonZeroBalances = Object.entries(balances).filter(([, v]) => parseFloat(v) > 0);

  logger.info('All non-zero balances on Binance account', {
    count: nonZeroBalances.length,
    balances: Object.fromEntries(nonZeroBalances),
  });

  const usdcBalance = balances['USDC'] || '0';
  const usdtBalance = balances['USDT'] || '0';
  const ethBalance = balances['ETH'] || '0';

  logger.info('Key asset balances', {
    USDC: usdcBalance,
    USDT: usdtBalance,
    ETH: ethBalance,
  });

  if (parseFloat(usdcBalance) === 0) {
    logger.warn('No USDC available on Binance. Nothing to withdraw.');
    process.exit(0);
  }

  logger.info(`USDC available for withdrawal: ${usdcBalance} USDC`);

  // Step 3: Withdrawal quota
  logger.info('Step 3: Checking withdrawal quota...');
  const quota = await client.getWithdrawQuota();
  const totalQuota = parseFloat(quota.wdQuota);
  const usedQuota = parseFloat(quota.usedWdQuota);
  const remainingQuota = totalQuota - usedQuota;

  logger.info('Withdrawal quota details', {
    totalQuotaUSD: `$${totalQuota.toFixed(2)}`,
    usedQuotaUSD: `$${usedQuota.toFixed(2)}`,
    remainingQuotaUSD: `$${remainingQuota.toFixed(2)}`,
  });

  const usdcBalanceNum = parseFloat(usdcBalance);
  if (usdcBalanceNum > remainingQuota) {
    logger.warn('USDC balance exceeds remaining quota', {
      usdcBalanceUSD: `$${usdcBalanceNum.toFixed(2)}`,
      remainingQuotaUSD: `$${remainingQuota.toFixed(2)}`,
      maxWithdrawableByQuota: `$${remainingQuota.toFixed(2)}`,
    });
  } else {
    logger.info('Quota check passed — sufficient for full balance withdrawal', {
      usdcBalanceUSD: `$${usdcBalanceNum.toFixed(2)}`,
      remainingQuotaUSD: `$${remainingQuota.toFixed(2)}`,
    });
  }

  // Step 4: USDC network config (fees, minimums, enabled status)
  logger.info('Step 4: Fetching USDC network configs from Binance...');
  const assetConfigs = await client.getAssetConfig();
  const usdcConfig = assetConfigs.find((c) => c.coin === 'USDC');

  if (!usdcConfig) {
    logger.error('USDC not found in Binance asset config!');
    process.exit(1);
  }

  logger.info(`Found ${usdcConfig.networkList.length} USDC networks on Binance`);

  for (const net of usdcConfig.networkList) {
    const chainId = BINANCE_NETWORK_TO_CHAIN_ID[net.network as keyof typeof BINANCE_NETWORK_TO_CHAIN_ID] || 'unknown';
    const fee = parseFloat(net.withdrawFee);
    const min = parseFloat(net.withdrawMin);
    const canWithdraw = net.withdrawEnable && usdcBalanceNum >= min + fee;

    logger.info(`Network: ${net.network}`, {
      chainId,
      depositEnabled: net.depositEnable,
      withdrawEnabled: net.withdrawEnable,
      withdrawFee: `${net.withdrawFee} USDC`,
      withdrawMin: `${net.withdrawMin} USDC`,
      withdrawMax: `${net.withdrawMax} USDC`,
      minConfirmations: net.minConfirm,
      canWithdrawFullBalance: canWithdraw,
    });
  }

  // Step 5: Summary — which chains can we actually withdraw to
  logger.info('Step 5: Withdrawal feasibility per supported chain');
  const supportedNetworks = ['ETH', 'ARBITRUM', 'OPTIMISM', 'BASE', 'BSC', 'MATIC', 'AVAXC', 'SCROLL', 'ZKSYNCERA', 'SONIC', 'RON'];

  for (const networkName of supportedNetworks) {
    const net = usdcConfig.networkList.find((n) => n.network === networkName);
    if (!net) {
      logger.debug(`${networkName}: not available on Binance for USDC`);
      continue;
    }

    const fee = parseFloat(net.withdrawFee);
    const min = parseFloat(net.withdrawMin);
    const maxWithdrawable = Math.min(usdcBalanceNum - fee, parseFloat(net.withdrawMax), remainingQuota);
    const canDo = net.withdrawEnable && usdcBalanceNum >= min + fee && maxWithdrawable > 0;

    if (canDo) {
      logger.info(`${networkName}: WITHDRAWAL POSSIBLE`, {
        maxWithdrawable: `${maxWithdrawable.toFixed(2)} USDC`,
        fee: `${fee} USDC`,
        min: `${min} USDC`,
        youReceive: `${(maxWithdrawable).toFixed(2)} USDC`,
      });
    } else if (!net.withdrawEnable) {
      logger.warn(`${networkName}: WITHDRAWAL DISABLED by Binance`);
    } else {
      logger.warn(`${networkName}: CANNOT WITHDRAW`, {
        reason: 'insufficient balance',
        required: `${(min + fee).toFixed(2)} USDC`,
        available: `${usdcBalanceNum.toFixed(2)} USDC`,
      });
    }
  }

  logger.info('Done. Check logs above for withdrawal feasibility.');
}

main().catch((err) => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
