import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  isOperationTimedOut,
  getBridgeTypeFromTag,
  registerBridgeTag,
  DEFAULT_OPERATION_TTL_MINUTES,
} from '../../src/rebalance/helpers';
import { SupportedBridge } from '@mark/core';

describe('isOperationTimedOut', () => {
  it('returns false for a freshly created operation', () => {
    const createdAt = new Date();
    expect(isOperationTimedOut(createdAt)).toBe(false);
  });

  it('returns true for an operation older than default TTL (24h)', () => {
    const createdAt = new Date(Date.now() - (DEFAULT_OPERATION_TTL_MINUTES + 1) * 60 * 1000);
    expect(isOperationTimedOut(createdAt)).toBe(true);
  });

  it('returns false for an operation just under the default TTL', () => {
    const createdAt = new Date(Date.now() - (DEFAULT_OPERATION_TTL_MINUTES - 1) * 60 * 1000);
    expect(isOperationTimedOut(createdAt)).toBe(false);
  });

  it('uses custom TTL when provided', () => {
    const customTtl = 60; // 1 hour
    const createdAt = new Date(Date.now() - 61 * 60 * 1000); // 61 minutes ago
    expect(isOperationTimedOut(createdAt, customTtl)).toBe(true);
  });

  it('returns false when custom TTL is not exceeded', () => {
    const customTtl = 60;
    const createdAt = new Date(Date.now() - 59 * 60 * 1000); // 59 minutes ago
    expect(isOperationTimedOut(createdAt, customTtl)).toBe(false);
  });

  it('returns true at the exact boundary (1ms over)', () => {
    const ttl = 10;
    const createdAt = new Date(Date.now() - ttl * 60 * 1000 - 1);
    expect(isOperationTimedOut(createdAt, ttl)).toBe(true);
  });
});

describe('getBridgeTypeFromTag', () => {
  it('resolves stargate-amanusde to Stargate (explicit mapping)', () => {
    expect(getBridgeTypeFromTag('stargate-amanusde')).toBe(SupportedBridge.Stargate);
  });

  it('resolves stargate-amansyrupusdt to Stargate (explicit mapping)', () => {
    expect(getBridgeTypeFromTag('stargate-amansyrupusdt')).toBe(SupportedBridge.Stargate);
  });

  it('resolves stargate-tac to Stargate (explicit mapping)', () => {
    expect(getBridgeTypeFromTag('stargate-tac')).toBe(SupportedBridge.Stargate);
  });

  it('resolves mantle to Mantle (explicit mapping)', () => {
    expect(getBridgeTypeFromTag(SupportedBridge.Mantle)).toBe(SupportedBridge.Mantle);
  });

  it('resolves across-mantle to Across (explicit mapping)', () => {
    expect(getBridgeTypeFromTag(`${SupportedBridge.Across}-mantle`)).toBe(SupportedBridge.Across);
  });

  it('resolves ccip-solana-mainnet to CCIP (explicit mapping)', () => {
    expect(getBridgeTypeFromTag('ccip-solana-mainnet')).toBe(SupportedBridge.CCIP);
  });

  it('falls back to prefix extraction for unknown tags with valid prefix', () => {
    // 'linea' is a valid SupportedBridge, so 'linea-custom' should resolve
    expect(getBridgeTypeFromTag('linea-custom')).toBe(SupportedBridge.Linea);
  });

  it('returns undefined for completely unknown tags', () => {
    expect(getBridgeTypeFromTag('unknown-bridge-foo')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getBridgeTypeFromTag('')).toBeUndefined();
  });
});

describe('registerBridgeTag', () => {
  it('registers a new tag that can be resolved', () => {
    registerBridgeTag('custom-new-tag', SupportedBridge.Zircuit);
    expect(getBridgeTypeFromTag('custom-new-tag')).toBe(SupportedBridge.Zircuit);
  });

  it('overrides existing fallback with explicit mapping', () => {
    // 'zircuit-special' would fallback to Zircuit via prefix
    // Register it explicitly as something else
    registerBridgeTag('pendle-override', SupportedBridge.Mantle);
    expect(getBridgeTypeFromTag('pendle-override')).toBe(SupportedBridge.Mantle);
  });
});
