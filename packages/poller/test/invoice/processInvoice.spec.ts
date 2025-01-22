import { expect } from 'chai';
import { isValidInvoice } from '../../src/invoice/processInvoices';
import { Invoice } from '@mark/everclear';
import { MarkConfiguration } from '@mark/core';

const validInvoice = {
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

const validConfig = {
  signer: '0xMark',
  supportedSettlementDomains: [8453],
} as MarkConfiguration;

describe('isValidInvoice', () => {
  it('should return true for a valid invoice', () => {
    const result = isValidInvoice(validInvoice, validConfig);
    expect(result).to.be.true;
  });

  it('should return false if invoice is null or undefined', () => {
    const resultNull = isValidInvoice(null as any, validConfig);
    const resultUndefined = isValidInvoice(undefined as any, validConfig);

    expect(resultNull).to.be.false;
    expect(resultUndefined).to.be.false;
  });

  it('should return false if id is not a string', () => {
    const { intent_id, ...res } = validInvoice;
    const invalidInvoice: Partial<Invoice> = {
      intent_id: 123 as any, // Invalid id type
      ...res,
    };

    const result = isValidInvoice(invalidInvoice as Invoice, validConfig);
    expect(result).to.be.false;
  });

  it('should return false if amount is not a number', () => {
    const { amount, ...res } = validInvoice;
    const invalidInvoice: Partial<Invoice> = {
      amount: 'abc',
      ...res,
    };

    const result = isValidInvoice(invalidInvoice as Invoice, validConfig);
    expect(result).to.be.false;
  });

  it('should return false if amount is less than or equal to 0', () => {
    const { amount, ...res } = validInvoice;
    const invalidInvoiceZero: Invoice = {
      amount: '0',
      ...res,
    };

    const invalidInvoiceNegative: Invoice = {
      amount: '-50',
      ...res,
    };

    expect(isValidInvoice(invalidInvoiceZero, validConfig)).to.be.false;
    expect(isValidInvoice(invalidInvoiceNegative, validConfig)).to.be.false;
  });

  it('should return false if owner matches "Mark wallet address"', () => {
    const { owner, ...res } = validInvoice;
    const invalidInvoice: Invoice = {
      owner: 'Mark wallet address', // Invalid owner
      ...res,
    };

    const result = isValidInvoice(invalidInvoice, validConfig);
    expect(result).to.be.false;
  });
});
