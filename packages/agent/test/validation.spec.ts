import { validateTokenRebalanceConfig } from '../src/validation';
import { Logger } from '@mark/logger';
import { MarkConfiguration, TokenRebalanceConfig } from '@mark/core';
import sinon, { createStubInstance, SinonStubbedInstance } from 'sinon';

describe('validateTokenRebalanceConfig', () => {
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockConfig: MarkConfiguration;

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
    mockConfig = {
      ownAddress: '0x1234567890123456789012345678901234567890',
      chains: {},
    } as MarkConfiguration;
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('when rebalancing is disabled', () => {
    it('should skip validation for disabled tacRebalance', () => {
      mockConfig.tacRebalance = {
        enabled: false,
      } as TokenRebalanceConfig;

      validateTokenRebalanceConfig(mockConfig, mockLogger);

      expect(mockLogger.debug.calledWithMatch('tacRebalance disabled')).toBe(true);
    });

    it('should skip validation for disabled methRebalance', () => {
      mockConfig.methRebalance = {
        enabled: false,
      } as TokenRebalanceConfig;

      validateTokenRebalanceConfig(mockConfig, mockLogger);

      expect(mockLogger.debug.calledWithMatch('methRebalance disabled')).toBe(true);
    });
  });

  describe('tacRebalance validation', () => {
    it('should validate successfully with complete config', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        marketMaker: {
          address: '0xMM',
          thresholdEnabled: true,
          threshold: '1000000',
          targetBalance: '5000000',
        },
        fillService: {
          address: '0xFS',
          thresholdEnabled: true,
          threshold: '500000',
          targetBalance: '2000000',
        },
        bridge: {
          minRebalanceAmount: '100000',
        },
      } as TokenRebalanceConfig;
      mockConfig.ownTonAddress = 'TON_ADDRESS';
      mockConfig.ton = {
        mnemonic: 'test mnemonic',
      };

      validateTokenRebalanceConfig(mockConfig, mockLogger);

      expect(mockLogger.info.calledWithMatch('tacRebalance config validated successfully')).toBe(true);
    });

    it('should throw error when MM address is missing but threshold is enabled', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        marketMaker: {
          thresholdEnabled: true,
          threshold: '1000000',
          targetBalance: '5000000',
        },
        bridge: {
          minRebalanceAmount: '100000',
        },
      } as TokenRebalanceConfig;

      expect(() => validateTokenRebalanceConfig(mockConfig, mockLogger)).toThrow(
        'tacRebalance config validation failed',
      );
    });

    it('should throw error when MM threshold is missing but thresholdEnabled is true', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        marketMaker: {
          address: '0xMM',
          thresholdEnabled: true,
          targetBalance: '5000000',
        },
        bridge: {
          minRebalanceAmount: '100000',
        },
      } as TokenRebalanceConfig;

      expect(() => validateTokenRebalanceConfig(mockConfig, mockLogger)).toThrow();
    });

    it('should throw error when MM targetBalance is missing but thresholdEnabled is true', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        marketMaker: {
          address: '0xMM',
          thresholdEnabled: true,
          threshold: '1000000',
        },
        bridge: {
          minRebalanceAmount: '100000',
        },
      } as TokenRebalanceConfig;

      expect(() => validateTokenRebalanceConfig(mockConfig, mockLogger)).toThrow();
    });

    it('should throw error when FS address is missing but thresholdEnabled is true', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        fillService: {
          thresholdEnabled: true,
          threshold: '500000',
          targetBalance: '2000000',
        },
        bridge: {
          minRebalanceAmount: '100000',
        },
      } as TokenRebalanceConfig;

      expect(() => validateTokenRebalanceConfig(mockConfig, mockLogger)).toThrow();
    });

    it('should throw error when bridge minRebalanceAmount is missing', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        bridge: {},
      } as TokenRebalanceConfig;

      expect(() => validateTokenRebalanceConfig(mockConfig, mockLogger)).toThrow();
    });

    it('should throw error when ownTonAddress is missing', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        marketMaker: {
          thresholdEnabled: false,
        },
        bridge: {
          minRebalanceAmount: '100000',
        },
      } as TokenRebalanceConfig;

      expect(() => validateTokenRebalanceConfig(mockConfig, mockLogger)).toThrow(
        'ownTonAddress (TON_SIGNER_ADDRESS) is required',
      );
    });

    it('should throw error when ton.mnemonic is missing', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        marketMaker: {
          thresholdEnabled: false,
        },
        bridge: {
          minRebalanceAmount: '100000',
        },
      } as TokenRebalanceConfig;
      mockConfig.ownTonAddress = 'TON_ADDRESS';

      expect(() => validateTokenRebalanceConfig(mockConfig, mockLogger)).toThrow(
        'ton.mnemonic (TON_MNEMONIC) is required',
      );
    });

    it('should warn when MM address differs from ownAddress', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        marketMaker: {
          address: '0xDIFFERENT',
          thresholdEnabled: true,
          threshold: '1000000',
          targetBalance: '5000000',
        },
        bridge: {
          minRebalanceAmount: '100000',
        },
      } as TokenRebalanceConfig;
      mockConfig.ownTonAddress = 'TON_ADDRESS';
      mockConfig.ton = {
        mnemonic: 'test mnemonic',
      };

      validateTokenRebalanceConfig(mockConfig, mockLogger);

      expect(mockLogger.warn.calledWithMatch('tacRebalance config warning')).toBe(true);
    });
  });

  describe('methRebalance validation', () => {
    it('should validate successfully with complete config', () => {
      mockConfig.methRebalance = {
        enabled: true,
        marketMaker: {
          address: '0xMM',
          thresholdEnabled: true,
          threshold: '1000000',
          targetBalance: '5000000',
        },
        fillService: {
          address: '0xFS',
          thresholdEnabled: true,
          threshold: '500000',
          targetBalance: '2000000',
        },
        bridge: {
          minRebalanceAmount: '100000',
        },
      } as TokenRebalanceConfig;

      validateTokenRebalanceConfig(mockConfig, mockLogger);

      expect(mockLogger.info.calledWithMatch('methRebalance config validated successfully')).toBe(true);
    });

    it('should throw error when bridge minRebalanceAmount is missing', () => {
      mockConfig.methRebalance = {
        enabled: true,
        bridge: {},
      } as TokenRebalanceConfig;

      expect(() => validateTokenRebalanceConfig(mockConfig, mockLogger)).toThrow();
    });
  });

  describe('error message formatting', () => {
    it('should include all errors in the thrown error message', () => {
      mockConfig.tacRebalance = {
        enabled: true,
        marketMaker: {
          thresholdEnabled: true,
        },
        bridge: {},
      } as TokenRebalanceConfig;

      expect(() => validateTokenRebalanceConfig(mockConfig, mockLogger)).toThrow(
        /tacRebalance config validation failed/,
      );
    });
  });
});
