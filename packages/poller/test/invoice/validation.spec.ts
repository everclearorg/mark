import { expect } from 'chai';
import { isValidInvoice } from '../../src/invoice';
import { MarkConfiguration, Invoice, InvalidPurchaseReasons, WalletType } from '@mark/core';
import * as assetHelpers from '../../src/helpers/asset';
import * as zodiacHelpers from '../../src/helpers/zodiac';
import sinon from 'sinon';

describe('isValidInvoice', () => {
  const validInvoice: Invoice = {
    intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
    owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
    entry_epoch: 186595,
    amount: '4506224658731513369685',
    discountBps: 1.2,
    origin: '1',
    destinations: ['8453'],
    hub_status: 'INVOICED',
    ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
    hub_invoice_enqueued_timestamp: 1737491219,
  };

  const validConfig: MarkConfiguration = {
    web3SignerUrl: '0xDifferentAddress',
    ownAddress: '0xDifferentAddress',
    supportedSettlementDomains: [8453],
    chains: {
      '8453': {
        invoiceAge: 3600, // 1 hour in seconds
        providers: ['provider'],
        assets: [{
          tickerHash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
          address: '0xtoken',
          decimals: 18,
          symbol: 'TEST'
        }]
      }
    }
  } as unknown as MarkConfiguration;

  beforeEach(() => {
    sinon.restore();
    // Mock Date.now() to return a fixed timestamp
    const now = 1737494819; // validInvoice.hub_invoice_enqueued_timestamp + 3600
    sinon.useFakeTimers(now * 1000);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should return undefined for a valid invoice', () => {
    sinon.stub(assetHelpers, 'getTickers').returns([validInvoice.ticker_hash]);
    const result = isValidInvoice(validInvoice, validConfig, Math.floor(Date.now() / 1000));
    expect(result).to.be.undefined;
  });

  describe('Format validation', () => {
    it('should return error string if invoice is null or undefined', () => {
      const nullResult = isValidInvoice(null as any, validConfig, Math.floor(Date.now() / 1000));
      const undefinedResult = isValidInvoice(undefined as any, validConfig, Math.floor(Date.now() / 1000));

      expect(nullResult).to.equal(InvalidPurchaseReasons.InvalidFormat);
      expect(undefinedResult).to.equal(InvalidPurchaseReasons.InvalidFormat);
    });

    it('should return error string if intent_id is not a string', () => {
      const invalidInvoice = {
        ...validInvoice,
        intent_id: 123 as any
      };
      expect(isValidInvoice(invalidInvoice, validConfig, Math.floor(Date.now() / 1000))).to.equal(
        InvalidPurchaseReasons.InvalidFormat
      );
    });

    it('should return error string if amount is not a valid BigInt string', () => {
      const invalidInvoice1 = {
        ...validInvoice,
        amount: 'not a number'
      };
      const invalidInvoice2 = {
        ...validInvoice,
        amount: '0'
      };
      const invalidInvoice3 = {
        ...validInvoice,
        amount: '-100'
      };

      expect(isValidInvoice(invalidInvoice1, validConfig, Math.floor(Date.now() / 1000))).to.equal(
        InvalidPurchaseReasons.InvalidAmount
      );
      expect(isValidInvoice(invalidInvoice2, validConfig, Math.floor(Date.now() / 1000))).to.equal(
        InvalidPurchaseReasons.InvalidFormat
      );
      expect(isValidInvoice(invalidInvoice3, validConfig, Math.floor(Date.now() / 1000))).to.equal(
        InvalidPurchaseReasons.InvalidFormat
      );
    });
  });

  describe('Owner validation', () => {
    it('should return error string if owner matches web3SignerUrl', () => {
      const invalidInvoice = {
        ...validInvoice,
        owner: validConfig.ownAddress
      };
      expect(isValidInvoice(invalidInvoice, validConfig, Math.floor(Date.now() / 1000))).to.equal(
        InvalidPurchaseReasons.InvalidOwner
      );
    });

    it('should return error string if owner matches web3SignerUrl in different case', () => {
      const invalidInvoice = {
        ...validInvoice,
        owner: validConfig.ownAddress.toUpperCase()
      };
      expect(isValidInvoice(invalidInvoice, validConfig, Math.floor(Date.now() / 1000))).to.equal(
        InvalidPurchaseReasons.InvalidOwner
      );
    });

    it('should return error string if owner matches Safe address when zodiac is enabled on origin', () => {
      const safeAddress = '0x9876543210987654321098765432109876543210' as `0x${string}`;

      // Create config with zodiac enabled on origin chain
      const configWithZodiac: MarkConfiguration = {
        ...validConfig,
        chains: {
          ...validConfig.chains,
          '1': { // origin chain
            ...validConfig.chains['8453'],
            zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
            zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
            gnosisSafeAddress: safeAddress
          }
        }
      };

      // Mock zodiac functions
      const mockZodiacConfig = {
        walletType: WalletType.Zodiac,
        moduleAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        roleKey: '0x1234567890123456789012345678901234567890123456789012345678901234' as `0x${string}`,
        safeAddress
      };

      sinon.stub(zodiacHelpers, 'getValidatedZodiacConfig').returns(mockZodiacConfig);
      sinon.stub(zodiacHelpers, 'getActualOwner').returns(safeAddress);
      sinon.stub(assetHelpers, 'getTickers').returns([validInvoice.ticker_hash]);

      const invalidInvoice = {
        ...validInvoice,
        owner: safeAddress // owner matches the Safe address
      };

      expect(isValidInvoice(invalidInvoice, configWithZodiac, Math.floor(Date.now() / 1000))).to.equal(
        InvalidPurchaseReasons.InvalidOwner
      );
    });

    it('should return undefined if owner does not match Safe address when zodiac is enabled on origin', () => {
      const safeAddress = '0x9876543210987654321098765432109876543210' as `0x${string}`;

      // Create config with zodiac enabled on origin chain
      const configWithZodiac: MarkConfiguration = {
        ...validConfig,
        chains: {
          ...validConfig.chains,
          '1': { // origin chain
            ...validConfig.chains['8453'],
            zodiacRoleModuleAddress: '0x1234567890123456789012345678901234567890',
            zodiacRoleKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
            gnosisSafeAddress: safeAddress
          }
        }
      };

      // Mock zodiac functions
      const mockZodiacConfig = {
        walletType: WalletType.Zodiac,
        moduleAddress: '0x1234567890123456789012345678901234567890' as `0x${string}`,
        roleKey: '0x1234567890123456789012345678901234567890123456789012345678901234' as `0x${string}`,
        safeAddress
      };

      sinon.stub(zodiacHelpers, 'getValidatedZodiacConfig').returns(mockZodiacConfig);
      sinon.stub(zodiacHelpers, 'getActualOwner').returns(safeAddress);
      sinon.stub(assetHelpers, 'getTickers').returns([validInvoice.ticker_hash]);

      const validInvoiceWithDifferentOwner = {
        ...validInvoice,
        owner: '0x1111111111111111111111111111111111111111' // different from Safe address
      };

      expect(isValidInvoice(validInvoiceWithDifferentOwner, configWithZodiac, Math.floor(Date.now() / 1000))).to.be.undefined;
    });
  });

  describe('Destination validation', () => {
    it('should return error string if no destinations match supported domains', () => {
      const invalidInvoice = {
        ...validInvoice,
        destinations: ['999999'] // Unsupported domain
      };
      expect(isValidInvoice(invalidInvoice, validConfig, Math.floor(Date.now() / 1000))).to.equal(
        InvalidPurchaseReasons.InvalidDestinations
      );
    });

    it('should return undefined if at least one destination is supported', () => {
      sinon.stub(assetHelpers, 'getTickers').returns([validInvoice.ticker_hash]);
      const validInvoiceMultiDest = {
        ...validInvoice,
        destinations: ['999999', '8453'] // One supported, one unsupported
      };
      expect(isValidInvoice(validInvoiceMultiDest, validConfig, Math.floor(Date.now() / 1000))).to.be.undefined;
    });
  });

  describe('Ticker validation', () => {
    it('should return error string if ticker is not supported', () => {
      const unsupportedTicker = '0xunsupportedticker';
      const supportedTicker = '0xdifferentticker';
      sinon.stub(assetHelpers, 'getTickers').returns([supportedTicker]);
      const invalidInvoice = {
        ...validInvoice,
        ticker_hash: unsupportedTicker
      };
      expect(isValidInvoice(invalidInvoice, validConfig, Math.floor(Date.now() / 1000))).to.equal(
        InvalidPurchaseReasons.InvalidTickers
      );
    });

    it('should return undefined if ticker is supported', () => {
      sinon.stub(assetHelpers, 'getTickers').returns([validInvoice.ticker_hash]);
      expect(isValidInvoice(validInvoice, validConfig, Math.floor(Date.now() / 1000))).to.be.undefined;
    });
  });
});
