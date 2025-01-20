import { expect } from 'chai';
import sinon from 'sinon';
import * as contractModule from '../../src/helpers/contracts';
import { walletBalance, markHighestLiquidityBalance } from '../../src/helpers/balance';
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

  describe('markHighestLiquidityBalance', () => {
    const mockConfig = {
      ownAddress: '0xOwnAddress',
      chains: {
        '1': { providers: ['https://mainnet.infura.io/v3/test'] },
        '2': { providers: ['https://other.infura.io/v3/test'] },
        '3': { providers: ['https://third.infura.io/v3/test'] },
      },
    };

    afterEach(() => {
      sinon.restore();
    });

    it('should return the domain with the highest liquidity', async () => {
      const getTokenAddressStub = sinon.stub();
      getTokenAddressStub
        .withArgs('0xTickerHash', '1')
        .resolves('0xTokenAddress1')
        .withArgs('0xTickerHash', '2')
        .resolves('0xTokenAddress2')
        .withArgs('0xTickerHash', '3')
        .resolves('0xTokenAddress3');

      const tokenContractStub = {
        read: {
          balanceOf: sinon.stub().onFirstCall().resolves(500).onSecondCall().resolves(1000).onThirdCall().resolves(700),
        },
      };

      sinon.stub(contractModule, 'getERC20Contract').resolves(tokenContractStub as any);

      const highestLiquidityDomain = await markHighestLiquidityBalance(
        '0xTickerHash',
        ['1', '2', '3'],
        mockConfig as any,
        getTokenAddressStub,
      );

      expect(highestLiquidityDomain).to.equal(2);
      expect(getTokenAddressStub.calledThrice).to.be.true;
      expect(getTokenAddressStub.firstCall.args).to.deep.equal(['0xTickerHash', '1']);
      expect(getTokenAddressStub.secondCall.args).to.deep.equal(['0xTickerHash', '2']);
      expect(getTokenAddressStub.thirdCall.args).to.deep.equal(['0xTickerHash', '3']);
    });

    it('should return 0 when an error occurs', async () => {
      const getTokenAddressStub = sinon.stub().rejects(new Error('Failed to fetch token address'));
      const consoleStub = sinon.stub(console, 'log');

      const highestLiquidityDomain = await markHighestLiquidityBalance(
        '0xTickerHash',
        ['1', '2', '3'],
        mockConfig as any,
        getTokenAddressStub,
      );

      expect(highestLiquidityDomain).to.equal(0);
      expect(consoleStub.calledOnceWith('Not able to fetch the wallet balance!')).to.be.true;
    });
  });
});
