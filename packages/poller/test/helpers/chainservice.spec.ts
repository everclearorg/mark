import * as sinon from 'sinon';
import { createStubInstance, SinonStubbedInstance } from 'sinon';
import { ChainService, ChainServiceConfig, EthWallet } from '@mark/chainservice';
import { Logger } from '@mark/logger';
import { TransactionRequest } from '@mark/core';

describe('ChainService submitAndMonitor Tron Tests', () => {
  let chainService: ChainService;
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockEthWallet: SinonStubbedInstance<EthWallet>;
  let mockTronWeb: any;
  let triggerSmartContractStub: sinon.SinonStub;
  let mockChimeraChainService: any;

  const TRON_CHAIN_ID = '728126428';
  const TOKEN_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
    mockEthWallet = createStubInstance(EthWallet);

    mockTronWeb = {
      defaultAddress: { hex: 'TESPzRJKmCFRGPhxgdbhf7PDjTuDx52pK8' },
      transactionBuilder: { triggerSmartContract: sinon.stub() },
      trx: {
        signTransaction: sinon.stub().resolves({ signature: ['signature'] }),
        sendRawTransaction: sinon.stub().resolves({ result: true, txid: 'mock-tx-hash' }),
        getTransactionInfo: sinon.stub().resolves({
          id: 'mock-tx-hash',
          blockNumber: 12345,
          blockTimeStamp: Date.now(),
          contractResult: [''],
          contract_address: '',
          receipt: {
            result: 'SUCCESS',
            energy_usage_total: 21000,
            energy_fee: 1000000
          },
          log: [],
          result: 'SUCCESS',
          resMessage: '',
          assetIssueID: '',
          withdraw_amount: 0,
          unfreeze_amount: 0,
          internal_transactions: [],
          exchange_received_amount: 0,
          exchange_inject_another_amount: 0,
          exchange_withdraw_another_amount: 0,
          exchange_another_amount: 0,
          exchange_id: 0,
          shielded_transaction_receipt: null,
          energy_usage: 0,
          energy_fee: 0,
          origin_energy_usage: 0,
          energy_usage_total: 0,
          net_usage: 0,
          net_fee: 0,
          resultCode: 'SUCCESS'
        })
      },
      event: {
        getEventsByTransactionID: sinon.stub().resolves([])
      },
    };

    triggerSmartContractStub = mockTronWeb.transactionBuilder.triggerSmartContract;

    // Mock successful triggerSmartContract response
    triggerSmartContractStub.resolves({
      result: { result: true },
      transaction: { raw_data: { contract: [] } },
    });

    const config: ChainServiceConfig = {
      chains: {
        [TRON_CHAIN_ID]: {
          providers: ['https://api.trongrid.io?apiKey=test-key'],
          privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
          assets: [],
          invoiceAge: 3600,
          gasThreshold: '1000000000000000000',
          deployments: {
            everclear: '0x1234567890123456789012345678901234567890',
            permit2: '0x1234567890123456789012345678901234567890',
            multicall3: '0x1234567890123456789012345678901234567890',
          },
        },
      },
    };

    mockChimeraChainService = {
      getAddress: sinon.stub().resolves('mock-address'),
      // Add any other methods that might be called
    };
    chainService = new ChainService(config, mockEthWallet as unknown as EthWallet, mockLogger, mockChimeraChainService);
    sinon.stub(chainService as any, 'getTronClient').returns(mockTronWeb);
  });

  describe('ERC20 Approval Function Selector Removal', () => {
    it('should remove function selector from rawParameter', async () => {
      const approveFunctionData = '0x095ea7b30000000000000000000000003104e840ef2a18abe54b1d3514ddfe989c0a89f6000000000000000000000000000000000000000000000000000000000002526c';

      const transaction: TransactionRequest = {
        to: TOKEN_ADDRESS,
        data: approveFunctionData,
        value: '0',
        chainId: +TRON_CHAIN_ID,
        funcSig: 'approve(address,uint256)',
      };

      await chainService.submitAndMonitor(TRON_CHAIN_ID, transaction);

      expect(triggerSmartContractStub.calledOnce).toBe(true);

      const callArgs = triggerSmartContractStub.firstCall.args;
      const contractAddress = callArgs[0];
      const functionSignature = callArgs[1];
      const options = callArgs[2];

      expect(contractAddress).toBe(TOKEN_ADDRESS);
      expect(functionSignature).toBe('approve(address,uint256)');

      const expectedParameterData = '0000000000000000000000003104e840ef2a18abe54b1d3514ddfe989c0a89f6000000000000000000000000000000000000000000000000000000000002526c';
      expect(options.rawParameter).toBe(expectedParameterData);
    });

    it('should remove function selector from rawParameter without 0x prefix', async () => {
      const approveFunctionData = '095ea7b30000000000000000000000003104e840ef2a18abe54b1d3514ddfe989c0a89f6000000000000000000000000000000000000000000000000000000000002526c';

      const transaction: TransactionRequest = {
        to: TOKEN_ADDRESS,
        data: approveFunctionData,
        value: '0',
        chainId: +TRON_CHAIN_ID,
        funcSig: 'approve(address,uint256)',
      };

      await chainService.submitAndMonitor(TRON_CHAIN_ID, transaction);

      expect(triggerSmartContractStub.calledOnce).toBe(true);

      const callArgs = triggerSmartContractStub.firstCall.args;
      const options = callArgs[2];

      const expectedParameterData = '0000000000000000000000003104e840ef2a18abe54b1d3514ddfe989c0a89f6000000000000000000000000000000000000000000000000000000000002526c';
      expect(options.rawParameter).toBe(expectedParameterData);
      expect(options.rawParameter).not.toMatch(/^095ea7b3/);
    });
  });
});