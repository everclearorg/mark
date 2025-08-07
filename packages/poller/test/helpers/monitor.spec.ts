import { expect } from '../globalTestHook';
import { SinonStubbedInstance, createStubInstance } from 'sinon';
import { Logger } from '@mark/logger';
import { MarkConfiguration, GasType } from '@mark/core';
import { logBalanceThresholds, logGasThresholds } from '../../src/helpers/monitor';

describe('Monitor Helpers', () => {
    let logger: SinonStubbedInstance<Logger>;
    let config: MarkConfiguration;

    beforeEach(() => {
        logger = createStubInstance(Logger);
        config = {
            chains: {
                'domain1': {
                    assets: [
                        { tickerHash: 'TICKER1', balanceThreshold: '1000' },
                        { tickerHash: 'TICKER2', balanceThreshold: '2000' }
                    ],
                    gasThreshold: '5000'
                },
                'domain2': {
                    assets: [
                        { tickerHash: 'TICKER1', balanceThreshold: '1500' }
                    ],
                    gasThreshold: '3000'
                }
            },
            web3SignerUrl: 'http://localhost:8080',
            everclearApiUrl: 'http://localhost:3000',
            ownAddress: '0x123',
            stage: 'test',
            environment: 'test',
            logLevel: 'info',
            pollingInterval: 1000,
            retryAttempts: 3,
            retryDelay: 1000,
            maxBatchSize: 10,
            supportedSettlementDomains: ['domain1', 'domain2'],
            supportedAssets: ['TICKER1', 'TICKER2'],
            hub: {
                domain: 'domain1',
                address: '0x456'
            }
        } as unknown as MarkConfiguration;
    });

    describe('logBalanceThresholds', () => {
        it('should log error when balance is below threshold', () => {
            const balances = new Map([
                ['TICKER1', new Map([
                    ['domain1', BigInt(500)], // Below threshold
                    ['domain2', BigInt(2000)] // Above threshold
                ])]
            ]);

            logBalanceThresholds(balances, config, logger);

            expect(logger.error.calledOnce).to.be.true;
            expect(logger.error.firstCall.args[0]).to.equal('Asset balance below threshold');
        });

        it('should log warning when asset is not configured', () => {
            const balances = new Map([
                ['UNKNOWN_TICKER', new Map([['domain1', BigInt(1000)]])]
            ]);

            logBalanceThresholds(balances, config, logger);

            expect(logger.warn.calledOnce).to.be.true;
            expect(logger.warn.firstCall.args[0]).to.equal('Asset not configured');
        });

        it('should handle case when balanceThreshold is not set', () => {
            // Create a config with an asset that has no balanceThreshold
            const configWithoutBalanceThreshold = {
                ...config,
                chains: {
                    'domain1': {
                        assets: [
                            { tickerHash: 'TICKER3' } // No balanceThreshold
                        ],
                        gasThreshold: '5000'
                    }
                }
            } as unknown as MarkConfiguration;

            const balances = new Map([
                ['TICKER3', new Map([
                    ['domain1', BigInt(500)]
                ])]
            ]);

            logBalanceThresholds(balances, configWithoutBalanceThreshold, logger);

            // Should not log error since the default threshold is '0'
            expect(logger.error.notCalled).to.be.true;
        });

        it('should handle case when balanceThreshold is explicitly set to zero', () => {
            // Create a config with an asset that has balanceThreshold set to '0'
            const configWithZeroBalanceThreshold = {
                ...config,
                chains: {
                    'domain1': {
                        assets: [
                            { tickerHash: 'TICKER3', balanceThreshold: '0' }
                        ],
                        gasThreshold: '5000'
                    }
                }
            } as unknown as MarkConfiguration;

            const balances = new Map([
                ['TICKER3', new Map([
                    ['domain1', BigInt(0)]
                ])]
            ]);

            logBalanceThresholds(balances, configWithZeroBalanceThreshold, logger);

            // Should not log error since the balance is equal to the threshold
            expect(logger.error.notCalled).to.be.true;
        });

        it('should handle when domain has no assets configured', () => {
            const configWithEmptyAssets = {
                ...config,
                chains: {
                    'domain1': {
                        // assets is undefined or empty array
                        gasThreshold: '5000'
                    }
                }
            } as unknown as MarkConfiguration;

            const balances = new Map([
                ['TICKER1', new Map([
                    ['domain1', BigInt(1000)]
                ])]
            ]);

            logBalanceThresholds(balances, configWithEmptyAssets, logger);

            expect(logger.warn.calledOnce).to.be.true;
            expect(logger.warn.firstCall.args[0]).to.equal('Asset not configured');
        });
    });

    describe('logGasThresholds', () => {
        beforeEach(() => {
            // Reset the logger before each test
            logger = createStubInstance(Logger);
        });

        it('should log error when gas balance is below threshold', () => {
            const gas = new Map([
                [{ chainId: 'domain1', gasType: GasType.Gas }, BigInt(4000)], // Below threshold
                [{ chainId: 'domain2', gasType: GasType.Gas }, BigInt(4000)] // Above threshold
            ]);

            logGasThresholds(gas, config, logger);

            expect(logger.error.called).to.be.true;
            const errorCall = logger.error.getCalls().find(
                call => call.args[0] === 'Gas balance is below threshold'
            );
            expect(errorCall).to.not.be.undefined;
        });

        it('should not log when gas balance is above threshold', () => {
            const gas = new Map([
                [{ chainId: 'domain1', gasType: GasType.Gas }, BigInt(6000)], // Above threshold
                [{ chainId: 'domain2', gasType: GasType.Gas }, BigInt(4000)] // Above threshold
            ]);

            logGasThresholds(gas, config, logger);

            const errorCalls = logger.error.getCalls().filter(
                call => call.args[0] === 'Gas balance is below threshold'
            );
            expect(errorCalls.length).to.equal(0);
        });

        it('should log error when there is no configured gas threshold', () => {
            // Create a config with a chain that has no gas threshold (explicitly set to empty string)
            const configWithoutThreshold = {
                ...config,
                chains: {
                    'domain3': {
                        assets: [],
                        gasThreshold: ''
                    }
                }
            } as unknown as MarkConfiguration;

            const gas = new Map([
                [{ chainId: 'domain3', gasType: GasType.Gas }, BigInt(5000)]
            ]);

            logGasThresholds(gas, configWithoutThreshold, logger);

            expect(logger.error.called).to.be.true;
            const errorCall = logger.error.getCalls().find(
                call => call.args[0] === 'No configured gas threshold'
            );
            expect(errorCall).to.not.be.undefined;
        });

        it('should handle when threshold is undefined', () => {
            // Create a config with a chain that has no gas threshold property at all
            const configWithUndefinedThreshold = {
                ...config,
                chains: {
                    'domain3': {
                        assets: []
                        // gasThreshold is not defined - will default to '0'
                    }
                }
            } as unknown as MarkConfiguration;

            const gas = new Map([
                [{ chainId: 'domain3', gasType: GasType.Gas }, BigInt(0)]  // Set to 0 to trigger the error condition
            ]);

            // Reset logger before this test
            logger = createStubInstance(Logger);

            logGasThresholds(gas, configWithUndefinedThreshold, logger);

            // When gasThreshold is undefined, it defaults to '0', and since gas is 0 (not > 0), it should log error
            expect(logger.error.called).to.be.true;
            const errorCall = logger.error.getCalls().find(
                call => call.args[0] === 'Gas balance is below threshold'
            );
            expect(errorCall).to.not.be.undefined;
        });

        it('should handle case when threshold is explicitly set to zero', () => {
            // Create a config with a chain that has threshold set to '0'
            const configWithZeroThreshold = {
                ...config,
                chains: {
                    'domain3': {
                        assets: [],
                        gasThreshold: '0'
                    }
                }
            } as unknown as MarkConfiguration;

            const gas = new Map([
                [{ chainId: 'domain3', gasType: GasType.Gas }, BigInt(100)]
            ]);

            // Reset logger before this test
            logger = createStubInstance(Logger);

            logGasThresholds(gas, configWithZeroThreshold, logger);

            // Since the balance (100) is greater than the threshold (0), it should not log an error
            const errorCalls = logger.error.getCalls().filter(
                call => call.args[0] === 'Gas balance is below threshold'
            );
            expect(errorCalls.length).to.equal(0);
        });

        it('should handle case when gas balance is exactly equal to threshold', () => {
            // Create a config with a specific threshold
            const configWithExactThreshold = {
                ...config,
                chains: {
                    'domain3': {
                        assets: [],
                        gasThreshold: '5000'
                    }
                }
            } as unknown as MarkConfiguration;

            const gas = new Map([
                [{ chainId: 'domain3', gasType: GasType.Gas }, BigInt(5000)] // Exactly equal to threshold
            ]);

            logGasThresholds(gas, configWithExactThreshold, logger);

            // Should log error since the balance is not greater than the threshold
            expect(logger.error.called).to.be.true;
            const errorCall = logger.error.getCalls().find(
                call => call.args[0] === 'Gas balance is below threshold'
            );
            expect(errorCall).to.not.be.undefined;
        });
    });
});
