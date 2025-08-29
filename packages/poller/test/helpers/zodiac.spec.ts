import { expect } from '../globalTestHook';
import { validateZodiacConfig } from '../../src/helpers/zodiac';
import { WalletConfig, WalletType } from '@mark/core';

describe('Zodiac Config Validation', () => {
  it('should throw error for invalid Safe address', () => {
    const invalidConfig: WalletConfig = {
      walletType: WalletType.Zodiac,
      safeAddress: 'invalid-safe-address' as any,
      moduleAddress: '0x1234567890123456789012345678901234567890',
      roleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    };

    expect(() => validateZodiacConfig(invalidConfig)).to.throw('Invalid Gnosis Safe address');
  });

  it('should throw error for invalid module address', () => {
    const invalidConfig: WalletConfig = {
      walletType: WalletType.Zodiac,
      safeAddress: '0x1234567890123456789012345678901234567890',
      moduleAddress: 'invalid-module-address' as any,
      roleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    };

    expect(() => validateZodiacConfig(invalidConfig)).to.throw('Invalid Zodiac Role Module address');
  });

  it('should throw error for invalid role key format', () => {
    const invalidConfig: WalletConfig = {
      walletType: WalletType.Zodiac,
      safeAddress: '0x1234567890123456789012345678901234567890',
      moduleAddress: '0x1234567890123456789012345678901234567890',
      roleKey: 'missing-0x-prefix' as any,
    };

    expect(() => validateZodiacConfig(invalidConfig)).to.throw('Invalid Zodiac Role Key format');
  });
});