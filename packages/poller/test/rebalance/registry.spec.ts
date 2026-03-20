import { describe, it, expect, beforeEach } from '@jest/globals';

// We need to test the registry in isolation, but it uses module-level state.
// Use jest.isolateModules to get fresh state per test.

describe('registry', () => {
  function loadFreshRegistry() {
    let mod: typeof import('../../src/rebalance/registry');
    jest.isolateModules(() => {
      mod = require('../../src/rebalance/registry');
    });
    return mod!;
  }

  it('registers a rebalancer and retrieves it', () => {
    const { registerRebalancer, getRegisteredRebalancers } = loadFreshRegistry();

    const handler = jest.fn();
    registerRebalancer({ runMode: 'testMode', displayName: 'Test', handler });

    const rebalancers = getRegisteredRebalancers();
    expect(rebalancers).toHaveLength(1);
    expect(rebalancers[0].runMode).toBe('testMode');
    expect(rebalancers[0].displayName).toBe('Test');
    expect(rebalancers[0].handler).toBe(handler);
  });

  it('throws on duplicate runMode registration', () => {
    const { registerRebalancer } = loadFreshRegistry();

    const handler = jest.fn();
    registerRebalancer({ runMode: 'dup', displayName: 'First', handler });

    expect(() => {
      registerRebalancer({ runMode: 'dup', displayName: 'Second', handler });
    }).toThrow('Duplicate rebalancer registration for runMode: dup');
  });

  it('allows different runModes', () => {
    const { registerRebalancer, getRegisteredRebalancers } = loadFreshRegistry();

    registerRebalancer({ runMode: 'a', displayName: 'A', handler: jest.fn() });
    registerRebalancer({ runMode: 'b', displayName: 'B', handler: jest.fn() });

    expect(getRegisteredRebalancers()).toHaveLength(2);
  });

  it('returns readonly array', () => {
    const { getRegisteredRebalancers } = loadFreshRegistry();
    const result = getRegisteredRebalancers();
    expect(Array.isArray(result)).toBe(true);
  });

  describe('getRegisteredBridgeTags', () => {
    it('returns empty set when no rebalancers have bridge tags', () => {
      const { registerRebalancer, getRegisteredBridgeTags } = loadFreshRegistry();

      registerRebalancer({ runMode: 'noTags', displayName: 'No Tags', handler: jest.fn() });

      const tags = getRegisteredBridgeTags();
      expect(tags.size).toBe(0);
    });

    it('collects bridge tags from all registered rebalancers', () => {
      const { registerRebalancer, getRegisteredBridgeTags } = loadFreshRegistry();

      registerRebalancer({
        runMode: 'a',
        displayName: 'A',
        handler: jest.fn(),
        bridgeTags: ['tag-a1', 'tag-a2'],
      });
      registerRebalancer({
        runMode: 'b',
        displayName: 'B',
        handler: jest.fn(),
        bridgeTags: ['tag-b1'],
      });
      registerRebalancer({
        runMode: 'c',
        displayName: 'C',
        handler: jest.fn(),
        // no bridgeTags
      });

      const tags = getRegisteredBridgeTags();
      expect(tags.size).toBe(3);
      expect(tags.has('tag-a1')).toBe(true);
      expect(tags.has('tag-a2')).toBe(true);
      expect(tags.has('tag-b1')).toBe(true);
    });

    it('deduplicates tags across registrations', () => {
      const { registerRebalancer, getRegisteredBridgeTags } = loadFreshRegistry();

      registerRebalancer({
        runMode: 'a',
        displayName: 'A',
        handler: jest.fn(),
        bridgeTags: ['shared-tag'],
      });
      registerRebalancer({
        runMode: 'b',
        displayName: 'B',
        handler: jest.fn(),
        bridgeTags: ['shared-tag'],
      });

      const tags = getRegisteredBridgeTags();
      expect(tags.size).toBe(1);
    });
  });
});
