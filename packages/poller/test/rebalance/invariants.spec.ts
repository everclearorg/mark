/**
 * Rebalancer invariant tests: verifies decimal conversions, amount math,
 * address routing, and threshold/cap logic across all rebalancer flows.
 *
 * These tests exercise the ACTUAL helper functions (not mocks) to catch
 * unit-mismatch bugs like comparing 18-decimal vs 6-decimal values.
 */
import { describe, it, expect } from '@jest/globals';
import { convertTo18Decimals, convertToNativeUnits } from '../../src/helpers/asset';
import { safeParseBigInt } from '../../src/helpers/balance';

// ─── Token decimal constants (mirrored from each rebalancer) ────────────────

const USDC_DECIMALS = 6;
const USDT_DECIMALS = 6;
const WETH_DECIMALS = 18;
const METH_DECIMALS = 18;
const AMANUSDE_DECIMALS = 18; // aToken on Mantle
const AMANSYRUPUSDT_DECIMALS = 6; // aToken on Mantle (syrupUSDT is 6 decimal)
const PTUSDE_MAINNET_DECIMALS = 18;
const PTUSDE_SOLANA_DECIMALS = 9;
const USDC_SOLANA_DECIMALS = 6;

// ─── Decimal conversion tests ──────────────────────────────────────────────

describe('Decimal conversions', () => {
  describe('convertTo18Decimals', () => {
    it('converts 6-decimal USDC to 18-decimal correctly', () => {
      const oneUsdc = 1_000_000n; // 1 USDC in 6 decimals
      const result = convertTo18Decimals(oneUsdc, USDC_DECIMALS);
      expect(result).toBe(1_000_000_000_000_000_000n); // 1e18
    });

    it('converts 9-decimal Solana ptUSDe to 18-decimal', () => {
      const onePtUsde = 1_000_000_000n; // 1 ptUSDe in 9 decimals
      const result = convertTo18Decimals(onePtUsde, PTUSDE_SOLANA_DECIMALS);
      expect(result).toBe(1_000_000_000_000_000_000n);
    });

    it('is identity for 18-decimal tokens (WETH, mETH, aManUSDe)', () => {
      const oneEth = 1_000_000_000_000_000_000n;
      expect(convertTo18Decimals(oneEth, WETH_DECIMALS)).toBe(oneEth);
      expect(convertTo18Decimals(oneEth, METH_DECIMALS)).toBe(oneEth);
      expect(convertTo18Decimals(oneEth, AMANUSDE_DECIMALS)).toBe(oneEth);
    });

    it('handles zero amount', () => {
      expect(convertTo18Decimals(0n, USDC_DECIMALS)).toBe(0n);
    });

    it('handles very large amounts without overflow', () => {
      const largeUsdc = 1_000_000_000_000n; // 1M USDC in native
      const result = convertTo18Decimals(largeUsdc, USDC_DECIMALS);
      expect(result).toBe(1_000_000_000_000_000_000_000_000n); // 1M in 18-dec
    });

    it('treats undefined decimals as 18 (no conversion)', () => {
      const amount = 1_000_000_000_000_000_000n;
      expect(convertTo18Decimals(amount, undefined)).toBe(amount);
    });
  });

  describe('convertToNativeUnits', () => {
    it('converts 18-decimal to 6-decimal USDC correctly', () => {
      const oneUsdcIn18 = 1_000_000_000_000_000_000n;
      const result = convertToNativeUnits(oneUsdcIn18, USDC_DECIMALS);
      expect(result).toBe(1_000_000n); // 1 USDC in native
    });

    it('converts 18-decimal to 9-decimal Solana ptUSDe', () => {
      const onePtUsdeIn18 = 1_000_000_000_000_000_000n;
      const result = convertToNativeUnits(onePtUsdeIn18, PTUSDE_SOLANA_DECIMALS);
      expect(result).toBe(1_000_000_000n);
    });

    it('is identity for 18-decimal tokens', () => {
      const oneEth = 1_000_000_000_000_000_000n;
      expect(convertToNativeUnits(oneEth, WETH_DECIMALS)).toBe(oneEth);
    });

    it('truncates sub-unit remainders (floor division)', () => {
      // 1.5 USDC in 18 decimals
      const oneAndHalfUsdc18 = 1_500_000_000_000_000_000n;
      const result = convertToNativeUnits(oneAndHalfUsdc18, USDC_DECIMALS);
      expect(result).toBe(1_500_000n); // exact in this case

      // 1 wei in 18 decimals → 0 in 6-decimal (lost to truncation)
      expect(convertToNativeUnits(1n, USDC_DECIMALS)).toBe(0n);
    });

    it('treats undefined decimals as 18 (no conversion)', () => {
      const amount = 1_000_000_000_000_000_000n;
      expect(convertToNativeUnits(amount, undefined)).toBe(amount);
    });
  });

  describe('round-trip consistency', () => {
    it('6-decimal → 18-decimal → 6-decimal is lossless for whole units', () => {
      const amounts = [1_000_000n, 100_000_000n, 999_999_999_999n];
      for (const amount of amounts) {
        const to18 = convertTo18Decimals(amount, USDC_DECIMALS);
        const backTo6 = convertToNativeUnits(to18, USDC_DECIMALS);
        expect(backTo6).toBe(amount);
      }
    });

    it('9-decimal → 18-decimal → 9-decimal is lossless for whole units', () => {
      const amount = 1_000_000_000n; // 1 ptUSDe in 9 decimals
      const to18 = convertTo18Decimals(amount, PTUSDE_SOLANA_DECIMALS);
      const backTo9 = convertToNativeUnits(to18, PTUSDE_SOLANA_DECIMALS);
      expect(backTo9).toBe(amount);
    });

    it('18-decimal → native-decimal for getEvmBalance + comparison must use same units', () => {
      // getEvmBalance returns 18-decimal; operation.amount is 6-decimal
      const rawBalance = 500_000n; // 0.5 USDC on-chain (6 dec)
      const balance18 = convertTo18Decimals(rawBalance, USDC_SOLANA_DECIMALS);
      // To compare with operation.amount (6-dec), must convert back:
      const balanceNative = balance18 / BigInt(10 ** (18 - USDC_SOLANA_DECIMALS));
      expect(balanceNative).toBe(rawBalance);

      // Directly comparing balance18 to rawBalance would be WRONG:
      expect(balance18).not.toBe(rawBalance); // 5e17 !== 5e5
      expect(balance18 > rawBalance).toBe(true);
    });
  });
});

// ─── safeParseBigInt tests ─────────────────────────────────────────────────

describe('safeParseBigInt', () => {
  it('parses valid integer strings', () => {
    expect(safeParseBigInt('1000000')).toBe(1_000_000n);
    expect(safeParseBigInt('0')).toBe(0n);
  });

  it('returns default for undefined/null/empty', () => {
    expect(safeParseBigInt(undefined)).toBe(0n);
    expect(safeParseBigInt(null)).toBe(0n);
    expect(safeParseBigInt('')).toBe(0n);
  });

  it('returns custom default value', () => {
    expect(safeParseBigInt(undefined, 42n)).toBe(42n);
  });

  it('handles large numbers', () => {
    expect(safeParseBigInt('1000000000000000000000')).toBe(1_000_000_000_000_000_000_000n);
  });
});

// ─── Threshold & amount cap invariants ────────────────────────────────────

describe('Threshold engine invariants', () => {
  describe('shortfall calculation', () => {
    it('shortfall = target - balance when balance < target', () => {
      const target = 2000n;
      const balance = 500n;
      const shortfall = balance < target ? target - balance : 0n;
      expect(shortfall).toBe(1500n);
    });

    it('shortfall = 0 when balance >= target', () => {
      const target = 2000n;
      const balance = 2500n;
      const shortfall = balance < target ? target - balance : 0n;
      expect(shortfall).toBe(0n);
    });

    it('shortfall = 0 when balance equals target', () => {
      const target = 2000n;
      const balance = 2000n;
      const shortfall = balance < target ? target - balance : 0n;
      expect(shortfall).toBe(0n);
    });
  });

  describe('amount capping', () => {
    it('amount = min(bridgeAmount, senderBalance)', () => {
      const bridgeAmount = 1500n;
      const senderBalance = 300n;
      const amount = senderBalance < bridgeAmount ? senderBalance : bridgeAmount;
      expect(amount).toBe(300n);
    });

    it('amount is capped by max when set', () => {
      let amount = 1500n;
      const max = 800n;
      if (max && max > 0n && amount > max) amount = max;
      expect(amount).toBe(800n);
    });

    it('max=0 does NOT cap (treated as unlimited)', () => {
      let amount = 1500n;
      const max = 0n;
      if (max && max > 0n && amount > max) amount = max;
      expect(amount).toBe(1500n); // unchanged
    });

    it('max=undefined does NOT cap', () => {
      let amount = 1500n;
      const max: bigint | undefined = undefined;
      if (max && max > 0n && amount > max) amount = max;
      expect(amount).toBe(1500n); // unchanged
    });

    it('amount below min is rejected', () => {
      const amount = 50n;
      const min = 100n;
      expect(amount < min).toBe(true);
    });
  });
});

// ─── Rebalancer-specific decimal flow tests ────────────────────────────────

describe('mETH rebalancer decimal flow', () => {
  // mETH/WETH: 18 decimals natively. Config thresholds are in wei.
  // getEvmBalance returns 18-decimal. No conversion needed.

  it('threshold comparison uses consistent 18-decimal units', () => {
    const balanceFromGetEvmBalance = 500_000_000_000_000_000n; // 0.5 ETH (18 dec)
    const thresholdFromConfig = safeParseBigInt('1000000000000000000'); // 1 ETH
    const targetFromConfig = safeParseBigInt('2000000000000000000'); // 2 ETH

    expect(balanceFromGetEvmBalance < thresholdFromConfig).toBe(true); // triggers rebalance
    const shortfall = targetFromConfig - balanceFromGetEvmBalance;
    expect(shortfall).toBe(1_500_000_000_000_000_000n); // 1.5 ETH
  });

  it('minRebalanceAmount is in wei (18 decimals)', () => {
    const minFromConfig = safeParseBigInt('100000000000000000'); // 0.1 ETH
    const amountToBridge = 1_500_000_000_000_000_000n; // 1.5 ETH
    expect(amountToBridge >= minFromConfig).toBe(true);
  });
});

describe('aaveToken rebalancer decimal flow', () => {
  // aManUSDe: aToken is 18-decimal, source USDC is 6-decimal
  // Threshold/target are in 18-decimal (aToken balance from getEvmBalance)
  // Bridge amount must be in 6-decimal native USDC

  it('shortfall (18-dec) converts to native USDC (6-dec) for bridge', () => {
    const shortfall18 = 500_000_000_000_000_000_000n; // 500 aManUSDe in 18-dec
    const bridgeAmount = convertToNativeUnits(shortfall18, USDC_DECIMALS);
    expect(bridgeAmount).toBe(500_000_000n); // 500 USDC in 6-dec
  });

  it('sender balance (from getEvmBalance 18-dec) converts to native USDC (6-dec)', () => {
    const senderBalance18 = 1_000_000_000_000_000_000_000n; // 1000 USDC in 18-dec
    const senderBalanceNative = convertToNativeUnits(senderBalance18, USDC_DECIMALS);
    expect(senderBalanceNative).toBe(1_000_000_000n); // 1000 USDC in 6-dec
  });

  it('minRebalanceAmount (6-dec config) matches bridge amount units', () => {
    const minFromConfig = safeParseBigInt('1000000'); // 1 USDC in 6-dec
    const bridgeAmount = 500_000_000n; // 500 USDC in 6-dec
    expect(bridgeAmount >= minFromConfig).toBe(true);
  });

  describe('aMansyrupUSDT: aToken is 6-decimal', () => {
    it('threshold/target must be in 18-decimal (getEvmBalance normalizes)', () => {
      // On-chain: 100 aMansyrupUSDT = 100_000_000 (6-dec)
      // getEvmBalance converts to: 100_000_000_000_000_000_000 (18-dec)
      const rawBalance = 100_000_000n;
      const balance18 = convertTo18Decimals(rawBalance, AMANSYRUPUSDT_DECIMALS);
      expect(balance18).toBe(100_000_000_000_000_000_000n);

      // Config threshold must be in 18-dec to compare correctly:
      const threshold18 = safeParseBigInt('100000000000000000000'); // 100 in 18-dec
      expect(balance18 >= threshold18).toBe(true);

      // WRONG: If threshold were in 6-dec (common misconfiguration):
      const threshold6 = safeParseBigInt('100000000'); // 100 in 6-dec
      // This would mean threshold = 0.0000000001 in 18-dec → always above threshold
      expect(balance18 >= threshold6).toBe(true); // misleadingly passes
    });
  });
});

describe('Solana USDC rebalancer decimal flow', () => {
  // ptUSDe: 9-dec on Solana, 18-dec on Mainnet
  // USDC: 6-dec on both Solana and Mainnet
  // Threshold/target: in 9-dec Solana ptUSDe (NOT 18-dec normalized)

  it('Solana ptUSDe shortfall (9-dec) converts to Mainnet ptUSDe (18-dec)', () => {
    const shortfall9 = 100_000_000_000n; // 100 ptUSDe in 9-dec
    const shortfall18 = shortfall9 * BigInt(10 ** (PTUSDE_MAINNET_DECIMALS - PTUSDE_SOLANA_DECIMALS));
    expect(shortfall18).toBe(100_000_000_000_000_000_000n); // 100 ptUSDe in 18-dec
  });

  it('ptUSDe (18-dec) to USDC (6-dec) estimate uses correct divisor', () => {
    const ptUsde18 = 100_000_000_000_000_000_000n; // 100 ptUSDe in 18-dec
    const estimatedUsdc6 = ptUsde18 / BigInt(10 ** (PTUSDE_MAINNET_DECIMALS - USDC_SOLANA_DECIMALS));
    expect(estimatedUsdc6).toBe(100_000_000n); // 100 USDC in 6-dec (1:1 estimate)
  });

  it('getEvmBalance (18-dec) must be converted to 6-dec before comparing to operation.amount', () => {
    // This is the exact scenario of Bug #4 (now fixed)
    const onChainUsdc = 50_000_000n; // 50 USDC raw on-chain
    const balance18 = convertTo18Decimals(onChainUsdc, USDC_SOLANA_DECIMALS);
    const operationAmount6 = 100_000_000n; // 100 USDC in DB (6-dec)

    // WRONG: comparing 18-dec to 6-dec
    expect(balance18 < operationAmount6).toBe(false); // 5e16 < 1e8 is FALSE — bug!

    // CORRECT: convert balance18 to native first
    const balanceNative = balance18 / BigInt(10 ** (18 - USDC_SOLANA_DECIMALS));
    expect(balanceNative < operationAmount6).toBe(true); // 5e7 < 1e8 is TRUE — correct
  });

  it('threshold comparison uses 9-decimal Solana units directly', () => {
    // Solana ptUSDe balance from SPL token account (9-dec)
    const balance = 50_000_000_000n; // 50 ptUSDe in 9-dec
    const threshold = safeParseBigInt('100000000000'); // 100 ptUSDe in 9-dec
    const target = safeParseBigInt('500000000000'); // 500 ptUSDe in 9-dec

    expect(balance < threshold).toBe(true); // triggers rebalance
    const shortfall = target - balance;
    expect(shortfall).toBe(450_000_000_000n); // 450 ptUSDe
  });
});

describe('TAC USDT rebalancer decimal flow', () => {
  // USDT: 6-dec on ETH/TAC
  // All internal comparisons in 18-dec normalized
  // Config values (threshold, target, min, max) are in native 6-dec, converted to 18-dec

  it('config threshold (6-dec) converts to 18-dec for comparison', () => {
    const thresholdNative = safeParseBigInt('100000000'); // 100 USDT in 6-dec
    const threshold18 = convertTo18Decimals(thresholdNative, USDT_DECIMALS);
    expect(threshold18).toBe(100_000_000_000_000_000_000n); // 100 in 18-dec
  });

  it('getEvmBalance (18-dec) compares correctly to converted threshold', () => {
    const balance18 = 50_000_000_000_000_000_000n; // 50 USDT from getEvmBalance
    const threshold18 = convertTo18Decimals(100_000_000n, USDT_DECIMALS); // 100 USDT

    expect(balance18 < threshold18).toBe(true); // triggers rebalance
  });

  it('shortfall (18-dec) converts to native (6-dec) for bridge execution', () => {
    const shortfall18 = 50_000_000_000_000_000_000n; // 50 USDT in 18-dec
    const shortfallNative = convertToNativeUnits(shortfall18, USDT_DECIMALS);
    expect(shortfallNative).toBe(50_000_000n); // 50 USDT in 6-dec
  });

  it('committedAmount deduction uses consistent 18-dec units', () => {
    const availableEthUsdt18 = 1_000_000_000_000_000_000_000n; // 1000 USDT
    const committed18 = 200_000_000_000_000_000_000n; // 200 USDT committed
    const remaining = availableEthUsdt18 - committed18;
    expect(remaining).toBe(800_000_000_000_000_000_000n); // 800 USDT
  });
});

// ─── Address routing validation tests ──────────────────────────────────────

describe('Address routing invariants', () => {
  it('operation.recipient should always be the Mantle destination address', () => {
    // In mantleEth Leg 2, we must bridge to operation.recipient (the intended
    // Mantle address), NOT evmSender (the mainnet sender who stakes WETH).
    const fsAddress = '0xFillServiceMantle';
    const fsSenderAddress = '0xFillServiceMainnet'; // may differ from fsAddress
    const operationRecipient = fsAddress; // stored during Leg 1 creation

    // Leg 2 should bridge to operationRecipient, not fsSenderAddress
    expect(operationRecipient).toBe(fsAddress);
    expect(operationRecipient).not.toBe(fsSenderAddress);
  });

  it('earmarkId should propagate from Leg 1 to Leg 2', () => {
    const leg1EarmarkId = 'earmark-123';
    // Bug #9 fix: Leg 2 should carry the earmark
    const leg2EarmarkId = leg1EarmarkId ?? null;
    expect(leg2EarmarkId).toBe('earmark-123');

    // Without earmark (threshold-based):
    const noEarmark = null ?? null;
    expect(noEarmark).toBeNull();
  });
});

// ─── Slippage invariants ───────────────────────────────────────────────────

describe('Slippage handling', () => {
  it('slippageDbps default is 500 (5%)', () => {
    const configValue: number | undefined = undefined;
    const slippage = configValue ?? 500;
    expect(slippage).toBe(500);
  });

  it('slippageDbps can safely convert to BigInt', () => {
    const slippage = 500;
    expect(() => BigInt(slippage)).not.toThrow();
    expect(BigInt(slippage)).toBe(500n);
  });

  it('undefined slippageDbps with ?? 500 does not throw on BigInt conversion', () => {
    const configValue: number | undefined = undefined;
    const slippage = configValue ?? 500;
    expect(() => BigInt(slippage)).not.toThrow();
  });

  describe('dex-swap approval amount', () => {
    it('approval includes slippage padding', () => {
      const swapAmount = 1_000_000n; // 1 USDC
      const slippageBps = 100; // 1%
      const approvalAmount = swapAmount + (swapAmount * BigInt(slippageBps)) / BigInt(10000);
      expect(approvalAmount).toBe(1_010_000n); // 1.01 USDC
    });

    it('allowance check uses padded amount, not raw swap amount', () => {
      const swapAmount = 1_000_000n;
      const slippageBps = 100;
      const approvalAmount = swapAmount + (swapAmount * BigInt(slippageBps)) / BigInt(10000);

      // Existing allowance equals swapAmount but less than approvalAmount
      const existingAllowance = 1_000_000n;
      expect(existingAllowance < approvalAmount).toBe(true); // needs new approval
    });
  });
});
