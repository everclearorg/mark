import { expect } from 'chai';
import { stub, SinonStub, restore } from 'sinon';
import { Wallet } from 'ethers';
import { Web3Signer } from '@mark/web3signer';
import { Address, encodeFunctionData, erc20Abi } from 'viem';
import {
  approvePermit2,
  getPermit2Signature,
  generatePermit2Nonce,
  generatePermit2Deadline,
} from '../../src/helpers/permit2';
import { ChainService } from '@mark/chainservice';
import { MarkConfiguration } from '@mark/core';

describe.only('Permit2 Helper Functions', () => {
  afterEach(() => {
    restore();
  });

  describe('generatePermit2Nonce', () => {
    it('should generate a hexadecimal string nonce', () => {
      const nonce = generatePermit2Nonce();
      expect(nonce).to.be.a('string');
      expect(nonce.length).to.be.greaterThan(0);
      // Should be a valid hexadecimal string, but without 0x prefix
      expect(/^[0-9a-f]+$/.test(nonce)).to.be.true;
    });

    it('should generate unique nonces on multiple calls', () => {
      // Generate multiple nonces and ensure they're different
      const now = Date.now();
      const dateNowStub = stub(Date, 'now');
      
      // First call
      dateNowStub.returns(now);
      const nonce1 = generatePermit2Nonce();
      
      // Second call with a different timestamp
      dateNowStub.returns(now + 100);
      const nonce2 = generatePermit2Nonce();
      
      // Restore the stub
      dateNowStub.restore();
      
      expect(nonce1).to.not.equal(nonce2);
    });
  });

  describe('generatePermit2Deadline', () => {
    it('should generate a deadline in the future with default duration', () => {
      const now = Math.floor(Date.now() / 1000);
      const deadline = generatePermit2Deadline();

      expect(deadline).to.be.a('number');
      expect(deadline).to.be.greaterThan(now);
      expect(deadline).to.be.approximately(now + 3600, 10); // Default is 1 hour (3600 seconds)
    });

    it('should generate a deadline with custom duration', () => {
      const now = Math.floor(Date.now() / 1000);
      const customDuration = 7200; // 2 hours
      const deadline = generatePermit2Deadline(customDuration);

      expect(deadline).to.be.approximately(now + customDuration, 10);
    });
  });

  describe('approvePermit2', () => {
    let chainService: any;
    let submitStub: SinonStub;
    const TEST_PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
    const mockConfig = {
      chains: {
        '1': {
          deployments: {
            permit2: TEST_PERMIT2_ADDRESS,
            everclear: '0xeverclear',
            multicall3: '0xmulticall3'
          }
        }
      }
    } as unknown as MarkConfiguration;

    beforeEach(() => {
      chainService = {
        submitAndMonitor: stub().resolves({ transactionHash: '0xapproval_tx_hash' }),
        config: {
          chains: {
            '1': {
              assets: [
                { address: '0xTOKEN_ADDRESS', ticker: 'TOKEN' }
              ],
              providers: ['https://ethereum.example.com']
            }
          }
        }
      };
      submitStub = chainService.submitAndMonitor as SinonStub;
    });

    it('should create an approval transaction with proper transaction data', async () => {
      const tokenAddress = '0xTOKEN_ADDRESS' as Address;
      
      const txHash = await approvePermit2(tokenAddress, chainService as ChainService, mockConfig);
      
      // Verify submitAndMonitor was called with the expected arguments
      expect(submitStub.calledOnce).to.be.true;
      
      const submitArgs = submitStub.firstCall.args;
      expect(submitArgs[0]).to.equal('1'); // chainId
      
      const txData = submitArgs[1];
      expect(txData.to).to.equal(tokenAddress);
      expect(txData.value).to.equal('0x0');
      
      // Validate the transaction data format
      expect(txData.data).to.be.a('string');
      expect(txData.data.startsWith('0x095ea7b3')).to.be.true; // ERC20 approve function selector
      
      // Check if the Permit2 address and maxUint256 are properly encoded
      const expectedData = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [TEST_PERMIT2_ADDRESS as Address, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')]
      });
      
      expect(txData.data).to.equal(expectedData);
      
      // Check the return value
      expect(txHash).to.equal('0xapproval_tx_hash');
    });

    it('should throw an error if token not found in configuration', async () => {
      const unknownTokenAddress = '0xUNKNOWN_TOKEN' as Address;
      
      try {
        await approvePermit2(unknownTokenAddress, chainService as ChainService, mockConfig);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('Could not find chain configuration for token');
      }
    });
  });

  describe('getPermit2Signature', () => {
    const TEST_PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
    const mockConfig = {
      chains: {
        '1': {
          deployments: {
            permit2: TEST_PERMIT2_ADDRESS,
            everclear: '0xeverclear',
            multicall3: '0xmulticall3'
          }
        }
      }
    } as unknown as MarkConfiguration;
    
    it('should throw an error if signer type is not supported', async () => {
      const invalidSigner = {} as any;
      
      // Stub console.error to prevent the error message from being logged
      const consoleErrorStub = stub(console, 'error');
      
      try {
        await getPermit2Signature(
          invalidSigner,
          1,
          '0x1234',
          '0x5678',
          '1000',
          '1',
          123456,
          mockConfig
        );
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.include('Signer does not support signTypedData method');
      } finally {
        consoleErrorStub.restore();
      }
    });

    it('should generate a valid signature using ethers Wallet', async () => {
      // Create a test Wallet with a stubbed _signTypedData method
      const privateKey = '0x1234567890123456789012345678901234567890123456789012345678901234';
      const realWallet = new Wallet(privateKey);
      const signTypedDataStub = stub(realWallet, '_signTypedData').resolves('0xmocksignature123456789012345678901234567890123456789012345678901234567890123456789012345678901234567890123456');
      
      const chainId = 1;
      const token = '0x1234567890123456789012345678901234567890';
      const spender = '0x0987654321098765432109876543210987654321';
      const amount = '1000000000000000000';
      const nonce = '123456';
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      
      // Generate the signature
      const signature = await getPermit2Signature(
        realWallet,
        chainId,
        token,
        spender,
        amount,
        nonce,
        deadline,
        mockConfig
      );
      
      // Verify the signature should be a hex string starting with 0x
      expect(signature).to.be.a('string');
      expect(signature.startsWith('0x')).to.be.true;
      
      // Verify _signTypedData was called with the correct parameters
      expect(signTypedDataStub.calledOnce).to.be.true;
      
      const [calledDomain, calledTypes, calledValue] = signTypedDataStub.firstCall.args;
      
      expect(calledDomain.name).to.equal('Permit2');
      expect(calledDomain.chainId).to.equal(chainId);
      expect(calledDomain.verifyingContract).to.equal(TEST_PERMIT2_ADDRESS);
      
      // Update the test to check for PermitTransferFrom types instead of PermitSingle
      expect(calledTypes.PermitTransferFrom).to.exist;
      expect(calledTypes.TokenPermissions).to.exist;
      
      // Update the test to check for the new value structure
      expect(calledValue.permitted.token).to.equal(token);
      expect(calledValue.permitted.amount).to.equal(amount);
      expect(calledValue.spender).to.equal(spender);
      expect(calledValue.nonce).to.exist;
      expect(calledValue.deadline).to.equal(deadline);
      
      signTypedDataStub.restore();
    });

    // TODO: This test just mocks Web3Signer and checks that the signature function is called with
    // the correct parameters. Test this in an integration test later.
    it('should call signTypedData with correct parameters when using Web3Signer', async () => {
      const mockSignTypedData = stub().resolves('0xmock_signature');
      
      // Create a mock that will pass the 'signTypedData' in signer check
      const mockWeb3Signer = {
        signTypedData: mockSignTypedData,
      } as unknown as Web3Signer;
      
      const chainId = 1;
      const token = '0x1234567890123456789012345678901234567890';
      const spender = '0x0987654321098765432109876543210987654321';
      const amount = '1000000000000000000';
      const nonce = '123456';
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      
      await getPermit2Signature(
        mockWeb3Signer,
        chainId,
        token,
        spender,
        amount,
        nonce,
        deadline,
        mockConfig
      );
      
      expect(mockSignTypedData.calledOnce).to.be.true;
      
      // Verify the arguments passed to signTypedData
      const args = mockSignTypedData.firstCall.args;
      const [domain, types, value] = args;
      
      expect(domain.name).to.equal('Permit2');
      expect(domain.chainId).to.equal(chainId);
      expect(domain.verifyingContract).to.equal(TEST_PERMIT2_ADDRESS);
      
      // Update the test to check for PermitTransferFrom types instead of PermitSingle
      expect(types.PermitTransferFrom).to.exist;
      expect(types.TokenPermissions).to.exist;
      
      // Update the test to check for the new value structure
      expect(value.permitted.token).to.equal(token);
      expect(value.permitted.amount).to.equal(amount);
      expect(value.spender).to.equal(spender);
      expect(value.nonce).to.exist;
      expect(value.deadline).to.equal(deadline);
    });
  });
}); 