import { setupTestDatabase, teardownTestDatabase, cleanupTestDatabase } from './setup';
import { isPaused, setPause } from '../src/db';

describe('Admin Actions - Pause Flags (integration)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    await cleanupTestDatabase();
  });

  afterEach(async () => {
    await teardownTestDatabase();
  });

  it('defaults to not paused when no records exist', async () => {
    const rebalance = await isPaused('rebalance');
    const purchase = await isPaused('purchase');
    expect(rebalance).toBe(false);
    expect(purchase).toBe(false);
  });

  it('can pause and unpause rebalance independently of purchase', async () => {
    // Pause rebalance
    await setPause('rebalance', true);
    expect(await isPaused('rebalance')).toBe(true);
    expect(await isPaused('purchase')).toBe(false);

    // Unpause rebalance
    await setPause('rebalance', false);
    expect(await isPaused('rebalance')).toBe(false);
    expect(await isPaused('purchase')).toBe(false);
  });

  it('can pause and unpause purchase independently of rebalance', async () => {
    // Pause purchase
    await setPause('purchase', true);
    expect(await isPaused('purchase')).toBe(true);
    expect(await isPaused('rebalance')).toBe(false);

    // Keep purchase paused, toggle rebalance on
    await setPause('rebalance', true);
    expect(await isPaused('purchase')).toBe(true);
    expect(await isPaused('rebalance')).toBe(true);

    // Unpause purchase only
    await setPause('purchase', false);
    expect(await isPaused('purchase')).toBe(false);
    expect(await isPaused('rebalance')).toBe(true);
  });

  it('records multiple snapshots and always reads latest state', async () => {
    // Start with all false
    expect(await isPaused('rebalance')).toBe(false);
    expect(await isPaused('purchase')).toBe(false);

    // Series of updates
    await setPause('rebalance', true);
    await setPause('purchase', true);
    await setPause('rebalance', false);

    // Latest should reflect last writes per flag
    expect(await isPaused('rebalance')).toBe(false);
    expect(await isPaused('purchase')).toBe(true);
  });
});

