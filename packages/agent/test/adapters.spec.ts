import { initializeBaseAdapters, BaseAdapterOptions } from '../src/adapters';
import { Logger } from '@mark/logger';
import { MarkConfiguration, TRON_CHAINID } from '@mark/core';
import { ChainService, EthWallet } from '@mark/chainservice';
import { Web3Signer } from '@mark/web3signer';
import { EverclearAdapter } from '@mark/everclear';
import { PurchaseCache } from '@mark/cache';
import { PrometheusAdapter } from '@mark/prometheus';
import { RebalanceAdapter } from '@mark/rebalance';
import * as database from '@mark/database';
import sinon, { createStubInstance, SinonStubbedInstance } from 'sinon';

// Mock dependencies
jest.mock('@mark/chainservice');
jest.mock('@mark/web3signer');
jest.mock('@mark/everclear');
jest.mock('@mark/cache');
jest.mock('@mark/prometheus');
jest.mock('@mark/rebalance');
jest.mock('@mark/database');

describe('initializeBaseAdapters', () => {
  let mockLogger: SinonStubbedInstance<Logger>;
  let mockConfig: MarkConfiguration;

  beforeEach(() => {
    mockLogger = createStubInstance(Logger);
    mockConfig = {
      web3SignerUrl: 'http://localhost:8545',
      everclearApiUrl: 'http://localhost:3000',
      redis: {
        host: 'localhost',
        port: 6379,
      },
      pushGatewayUrl: 'http://localhost:9091',
      logLevel: 'info',
      chains: {
        '1': {
          providers: ['http://localhost:8545'],
          assets: [],
          deployments: {
            everclear: '0x1234567890123456789012345678901234567890',
            permit2: '0x1234567890123456789012345678901234567890',
            multicall3: '0x1234567890123456789012345678901234567890',
          },
          invoiceAge: 3600,
          gasThreshold: '1000000000000000000',
        },
      },
      database: {
        connectionString: 'postgresql://localhost/test',
        maxConnections: 5,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
      },
      ownAddress: '0x1234567890123456789012345678901234567890',
      stage: 'test',
      environment: 'test',
    } as unknown as MarkConfiguration;

    // Reset environment
    delete process.env.TRON_PRIVATE_KEY;
  });

  afterEach(() => {
    sinon.restore();
  });

  it('should initialize base adapters with HTTP web3signer URL', () => {
    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
    };

    const adapters = initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(adapters.chainService).toBeInstanceOf(ChainService);
    expect(adapters.everclear).toBeInstanceOf(EverclearAdapter);
    expect(adapters.purchaseCache).toBeInstanceOf(PurchaseCache);
    expect(adapters.prometheus).toBeInstanceOf(PrometheusAdapter);
    expect(adapters.rebalance).toBeInstanceOf(RebalanceAdapter);
    expect(adapters.web3Signer).toBeDefined();
    expect(database.initializeDatabase).toHaveBeenCalledWith(mockConfig.database);
  });

  it('should initialize base adapters with private key web3signer URL', () => {
    mockConfig.web3SignerUrl = '0x1234567890123456789012345678901234567890123456789012345678901234';
    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
    };

    const adapters = initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(adapters.chainService).toBeInstanceOf(ChainService);
    expect(adapters.web3Signer).toBeDefined();
  });

  it('should set Tron private key from config', () => {
    const tronPrivateKey = '0xabcdef1234567890';
    mockConfig.chains[TRON_CHAINID] = {
      providers: ['http://localhost:8545'],
      privateKey: tronPrivateKey,
      assets: [],
      deployments: {
        everclear: '0x1234567890123456789012345678901234567890',
        permit2: '0x1234567890123456789012345678901234567890',
        multicall3: '0x1234567890123456789012345678901234567890',
      },
      invoiceAge: 3600,
      gasThreshold: '1000000000000000000',
    };

    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
    };

    initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(process.env.TRON_PRIVATE_KEY).toBe(tronPrivateKey);
    expect(mockLogger.info.calledWith('Using Tron signer key from configuration')).toBe(true);
  });

  it('should warn when Tron private key is not configured', () => {
    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
    };

    initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(mockLogger.warn.calledWith('Tron signer key is not in configuration')).toBe(true);
  });

  it('should initialize fill service chain service when configured', () => {
    mockConfig.fillServiceSignerUrl = 'http://localhost:8546';
      mockConfig.tacRebalance = {
        enabled: true,
        fillService: {
          address: '0x9876543210987654321098765432109876543210',
          thresholdEnabled: false,
        },
        marketMaker: {
          thresholdEnabled: false,
          onDemandEnabled: false,
        },
        bridge: {
          slippageDbps: 100,
          minRebalanceAmount: '1000000',
        },
      };

    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
    };

    const adapters = initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(adapters.fillServiceChainService).toBeInstanceOf(ChainService);
    expect(mockLogger.info.calledWithMatch('Initializing Fill Service chain service')).toBe(true);
  });

  it('should not initialize fill service chain service when not configured', () => {
    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
    };

    const adapters = initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(adapters.fillServiceChainService).toBeUndefined();
  });

  it('should initialize Solana signer when requested and configured', () => {
    mockConfig.solana = {
      privateKey: 'test-private-key',
      rpcUrl: 'http://localhost:8899',
    };

    // Mock createSolanaSigner to return a mock signer
    const { createSolanaSigner } = require('@mark/chainservice');
    const mockSolanaSigner = {
      getAddress: jest.fn().mockReturnValue('SolanaAddress123'),
    };
    createSolanaSigner.mockReturnValue(mockSolanaSigner);

    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
      includeSolanaSigner: true,
    };

    const adapters = initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(adapters.solanaSigner).toBeDefined();
    expect(mockLogger.info.calledWithMatch('Solana signer initialized')).toBe(true);
  });

  it('should not initialize Solana signer when not requested', () => {
    mockConfig.solana = {
      privateKey: 'test-private-key',
      rpcUrl: 'http://localhost:8899',
    };

    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
      includeSolanaSigner: false,
    };

    const adapters = initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(adapters.solanaSigner).toBeUndefined();
  });

  it('should not initialize Solana signer when not configured', () => {
    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
      includeSolanaSigner: true,
    };

    const adapters = initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(adapters.solanaSigner).toBeUndefined();
    expect(mockLogger.debug.calledWithMatch('Solana signer not configured')).toBe(true);
  });

  it('should handle Solana signer initialization failure gracefully', () => {
    mockConfig.solana = {
      privateKey: 'invalid-key',
      rpcUrl: 'http://localhost:8899',
    };

    // Mock createSolanaSigner to throw an error
    const { createSolanaSigner } = require('@mark/chainservice');
    createSolanaSigner.mockImplementation(() => {
      throw new Error('Failed to initialize');
    });

    const options: BaseAdapterOptions = {
      serviceName: 'test-service',
      includeSolanaSigner: true,
    };

    const adapters = initializeBaseAdapters(mockConfig, mockLogger, options);

    expect(adapters.solanaSigner).toBeUndefined();
    expect(mockLogger.error.calledWithMatch('Failed to initialize Solana signer')).toBe(true);
  });
});
