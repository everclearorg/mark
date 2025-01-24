import sinon from 'sinon';
import { Invoice } from '@mark/everclear';

describe('processBatch', () => {
  const mockInvoices: Invoice[] = [
    {
      intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
      owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
      entry_epoch: 186595,
      amount: '1506224658731513369685',
      discountBps: 1.2,
      origin: '1',
      destinations: ['8453'],
      hub_status: 'INVOICED',
      ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
      hub_invoice_enqueued_timestamp: 1737491219,
    },
    {
      intent_id: '0x60d2ec64161aed1c3846304775134d9da6d716b1f718176e6f24cb34b26950d0',
      owner: '0xe358babAbc57442a25Ab72196a9F80ff1c730300',
      entry_epoch: 186595,
      amount: '1706224658731513369685',
      discountBps: 1.2,
      origin: '1',
      destinations: ['8453'],
      hub_status: 'INVOICED',
      ticker_hash: '0xd6aca1be9729c13d677335161321649cccae6a591554772516700f986f942eaa',
      hub_invoice_enqueued_timestamp: 1737491219,
    },
  ];

  afterEach(() => {
    sinon.restore();
  });

});
