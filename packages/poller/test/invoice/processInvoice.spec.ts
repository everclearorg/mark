import { expect } from 'chai';
import { isValidInvoice, Invoice } from '../../src/invoice/processInvoices';

describe('isValidInvoice', () => {
  it('should return true for a valid invoice', () => {
    const validInvoice: Invoice = {
      id: 'invoice123',
      amount: 100,
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(validInvoice);
    expect(result).to.be.true;
  });

  it('should return false if invoice is null or undefined', () => {
    const resultNull = isValidInvoice(null as any);
    const resultUndefined = isValidInvoice(undefined as any);

    expect(resultNull).to.be.false;
    expect(resultUndefined).to.be.false;
  });

  it('should return false if id is not a string', () => {
    const invalidInvoice: Partial<Invoice> = {
      id: 123 as any, // Invalid id type
      amount: 100,
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(invalidInvoice as Invoice);
    expect(result).to.be.false;
  });

  it('should return false if amount is not a number', () => {
    const invalidInvoice: Partial<Invoice> = {
      id: 'invoice123',
      amount: '100' as any, // Invalid amount type
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(invalidInvoice as Invoice);
    expect(result).to.be.false;
  });

  it('should return false if amount is not a valid number', () => {
    const invalidInvoice: Invoice = {
      id: 'invoice123',
      amount: 'abc' as any, // Invalid amount
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(invalidInvoice);
    expect(result).to.be.false;
  });

  it('should return false if amount is less than or equal to 0', () => {
    const invalidInvoiceZero: Invoice = {
      id: 'invoice123',
      amount: 0, // Zero amount
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const invalidInvoiceNegative: Invoice = {
      id: 'invoice123',
      amount: -50, // Negative amount
      chainId: '1',
      owner: 'someOwner',
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    expect(isValidInvoice(invalidInvoiceZero)).to.be.false;
    expect(isValidInvoice(invalidInvoiceNegative)).to.be.false;
  });

  it('should return false if owner matches "Mark wallet address"', () => {
    const invalidInvoice: Invoice = {
      id: 'invoice123',
      amount: 100,
      chainId: '1',
      owner: 'Mark wallet address', // Invalid owner
      destinations: ['2', '3'],
      ticker_hash: '0xhash',
    };

    const result = isValidInvoice(invalidInvoice);
    expect(result).to.be.false;
  });
});
