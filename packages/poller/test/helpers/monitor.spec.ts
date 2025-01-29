import { expect } from '../globalTestHook';
import { SinonStubbedInstance, createStubInstance } from 'sinon';
import { Logger } from '@mark/logger';
import { MarkConfiguration } from '@mark/core';
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
    });

    describe('logGasThresholds', () => {
        it('should log error when gas balance is below threshold', () => {
            const gas = new Map([
                ['domain1', BigInt(4000)], // Below threshold
                ['domain2', BigInt(4000)] // Above threshold
            ]);

            logGasThresholds(gas, config, logger);

            expect(logger.error.calledOnce).to.be.true;
            expect(logger.error.firstCall.args[0]).to.equal('Gas balance is below threshold');
        });

        it('should not log when gas balance is above threshold', () => {
            const gas = new Map([
                ['domain1', BigInt(6000)], // Above threshold
                ['domain2', BigInt(4000)] // Above threshold
            ]);

            logGasThresholds(gas, config, logger);

            expect(logger.error.notCalled).to.be.true;
        });
    });
});
