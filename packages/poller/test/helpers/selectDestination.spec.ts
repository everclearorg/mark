import { expect } from 'chai';
import sinon from 'sinon';
import { findBestDestination } from '../../src/helpers/selectDestination';
import * as contractModule from '../../src/helpers/contracts';

describe('findBestDestination', () => {
  const mockConfig = {
    chains: {
      '1': { providers: ['https://mainnet.infura.io/v3/test'] },
      '2': { providers: ['https://other.infura.io/v3/test'] },
      '3': { providers: ['https://third.infura.io/v3/test'] },
    },
  };

  afterEach(() => {
    sinon.restore();
  });

  it('should return the best destination with the highest liquidity', async () => {
    const hubStorageStub = {
      read: {
        assetHash: sinon.stub().callsFake((args) => {
          if (args[1] === '2') return Promise.resolve('0xAssetHash2');
          if (args[1] === '3') return Promise.resolve('0xAssetHash3');
          throw new Error(`Unexpected arguments for assetHash: ${args}`);
        }),
        custodiedAsset: sinon.stub().callsFake((args) => {
          if (args[0] === '0xAssetHash2') return Promise.resolve(BigInt(500));
          if (args[0] === '0xAssetHash3') return Promise.resolve(BigInt(1000));
          throw new Error(`Unexpected arguments for custodiedAsset: ${args}`);
        }),
      },
    };

    sinon.stub(contractModule, 'getHubStorageContract').resolves(hubStorageStub as any);

    const bestDestination = await findBestDestination('1', '0xTickerHash', mockConfig as any);

    expect(bestDestination).to.equal(3); // Chain 3 has the highest liquidity (1000)
    expect(hubStorageStub.read.assetHash.calledTwice).to.be.true;
    expect(hubStorageStub.read.custodiedAsset.calledTwice).to.be.true;
  });

  it('should throw an error if no suitable destination is found', async () => {
    const hubStorageStub = {
      read: {
        assetHash: sinon.stub().resolves('0xAssetHash'),
        custodiedAsset: sinon.stub().resolves(BigInt(0)), // All destinations have 0 liquidity
      },
    };

    sinon.stub(contractModule, 'getHubStorageContract').resolves(hubStorageStub as any);

    try {
      await findBestDestination('1', '0xTickerHash', mockConfig as any);
      throw new Error('Expected function to throw an error, but it did not.');
    } catch (error: any) {
      expect(error.message).to.equal(
        'Failed to find the best destination: No suitable destination found with sufficient liquidity.',
      );
    }
  });

  it('should handle errors gracefully and throw a wrapped error', async () => {
    const hubStorageStub = {
      read: {
        assetHash: sinon.stub().rejects(new Error('AssetHash fetch failed')),
      },
    };

    sinon.stub(contractModule, 'getHubStorageContract').resolves(hubStorageStub as any);

    try {
      await findBestDestination('1', '0xTickerHash', mockConfig as any);
      throw new Error('Expected function to throw an error, but it did not.');
    } catch (error: any) {
      expect(error.message).to.equal('Failed to find the best destination: AssetHash fetch failed');
    }
  });
});
