import { expect } from 'chai';
import sinon from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { walletBalance } from '../../src/helpers/balance';
import * as coreFns from '@mark/core';

describe('Wallet Balance Utilities', () => {
  const mockConfig = {
    ownAddress: '0xOwnAddress',
    chains: {
      '1': { providers: ['https://mainnet.infura.io/v3/test'] },
      '2': { providers: ['https://other.infura.io/v3/test'] },
    },
  };

  afterEach(() => {
    sinon.restore();
  });

  describe('walletBalance', () => {
    it('should return the wallet balance successfully', async () => {
      const tokenContractStub = {
        read: {
          balanceOf: sinon.stub().resolves('1000'),
        },
      };
      sinon.stub(contractModule, 'getERC20Contract').resolves(tokenContractStub as any);

      const balance = await walletBalance('0xTokenAddress', '1', mockConfig as any);

      expect(balance).to.equal('1000');
    });

    it('should log an error and return undefined on failure', async () => {
      const consoleStub = sinon.stub(console, 'log');
      sinon.stub(contractModule, 'getERC20Contract').rejects(new Error('Contract error'));

      const balance = await walletBalance('0xTokenAddress', '1', mockConfig as any);

      expect(balance).to.be.undefined;
      expect(consoleStub.calledOnceWith('Not able to fetch the wallet balance!')).to.be.true;
    });
  });
});
