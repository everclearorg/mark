import { expect } from 'chai';
import { isValidInvoice } from '../../src/invoice';
import { Invoice } from '@mark/everclear';
import { MarkConfiguration } from '@mark/core';
import * as assetHelpers from '../../src/helpers/asset';
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
    supportedSettlementDomains: [8453],
    invoiceAge: 3600, // 1 hour in seconds
    chains: {
      '8453': {
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

  it('should return true for a valid invoice', () => {
    sinon.stub(assetHelpers, 'getTickers').returns([validInvoice.ticker_hash]);
    const result = isValidInvoice(validInvoice, validConfig);
    expect(result).to.be.true;
  });

  describe('Format validation', () => {
    it('should return false if invoice is null or undefined', () => {
      expect(isValidInvoice(null as any, validConfig)).to.be.false;
      expect(isValidInvoice(undefined as any, validConfig)).to.be.false;
    });

    it('should return false if intent_id is not a string', () => {
      const invalidInvoice = {
        ...validInvoice,
        intent_id: 123 as any
      };
      expect(isValidInvoice(invalidInvoice, validConfig)).to.be.false;
    });

    it('should return false if amount is not a valid BigInt string', () => {
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

      expect(isValidInvoice(invalidInvoice1, validConfig)).to.be.false;
      expect(isValidInvoice(invalidInvoice2, validConfig)).to.be.false;
      expect(isValidInvoice(invalidInvoice3, validConfig)).to.be.false;
    });
  });

  describe('Owner validation', () => {
    it('should return false if owner matches web3SignerUrl', () => {
      const invalidInvoice = {
        ...validInvoice,
        owner: validConfig.web3SignerUrl
      };
      expect(isValidInvoice(invalidInvoice, validConfig)).to.be.false;
    });

    it('should return false if owner matches web3SignerUrl in different case', () => {
      const invalidInvoice = {
        ...validInvoice,
        owner: validConfig.web3SignerUrl.toUpperCase()
      };
      expect(isValidInvoice(invalidInvoice, validConfig)).to.be.false;
    });
  });

  describe('Age validation', () => {
    it('should return false if invoice is too recent', () => {
      const now = Math.floor(Date.now() / 1000);
      const recentInvoice = {
        ...validInvoice,
        hub_invoice_enqueued_timestamp: now - (validConfig.invoiceAge / 2) // Half the required age
      };
      expect(isValidInvoice(recentInvoice, validConfig)).to.be.false;
    });

    it('should return true if invoice is old enough', () => {
      sinon.stub(assetHelpers, 'getTickers').returns([validInvoice.ticker_hash]);
      const now = Math.floor(Date.now() / 1000);
      const oldInvoice = {
        ...validInvoice,
        hub_invoice_enqueued_timestamp: now - (validConfig.invoiceAge * 2) // Twice the required age
      };
      expect(isValidInvoice(oldInvoice, validConfig)).to.be.true;
    });
  });

  describe('Destination validation', () => {
    it('should return false if no destinations match supported domains', () => {
      const invalidInvoice = {
        ...validInvoice,
        destinations: ['999999'] // Unsupported domain
      };
      expect(isValidInvoice(invalidInvoice, validConfig)).to.be.false;
    });

    it('should return true if at least one destination is supported', () => {
      sinon.stub(assetHelpers, 'getTickers').returns([validInvoice.ticker_hash]);
      const validInvoiceMultiDest = {
        ...validInvoice,
        destinations: ['999999', '8453'] // One supported, one unsupported
      };
      expect(isValidInvoice(validInvoiceMultiDest, validConfig)).to.be.true;
    });
  });

  describe('Ticker validation', () => {
    it('should return false if ticker is not supported', () => {
      sinon.stub(assetHelpers, 'getTickers').returns(['0xdifferentticker']);
      const invalidInvoice = {
        ...validInvoice,
        ticker_hash: '0xunsupportedticker'
      };
      expect(isValidInvoice(invalidInvoice, validConfig)).to.be.false;
    });

    it('should return true if ticker is supported', () => {
      sinon.stub(assetHelpers, 'getTickers').returns([validInvoice.ticker_hash]);
      expect(isValidInvoice(validInvoice, validConfig)).to.be.true;
    });
  });
});
