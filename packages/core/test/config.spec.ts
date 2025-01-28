import { expect } from './globalTestHook';
import { stub, SinonStub } from 'sinon';
import * as axios from '../src/axios';
import {
    loadConfiguration,
    getEverclearConfig,
    getTokenAddressFromConfig,
    getDecimalsFromConfig,
    ConfigurationError,
    EVERCLEAR_MAINNET_CONFIG_URL,
    EVERCLEAR_TESTNET_CONFIG_URL,
} from '../src/config';

describe('config', () => {
    let axiosGetStub: SinonStub;
    let processEnvBackup: NodeJS.ProcessEnv;

    const mockEverclearConfig = {
        chains: {
            '1': {
                providers: ['http://eth.provider'],
                assets: {
                    ETH: {
                        symbol: 'ETH',
                        address: '0xeth',
                        decimals: 18,
                        tickerHash: 'ETH',
                        isNative: true
                    }
                }
            }
        },
        hub: {
            domain: '25327',
            providers: ['http://hub.provider'],
            assets: {
                HUB: {
                    symbol: 'HUB',
                    address: '0xhub',
                    decimals: 18,
                    tickerHash: 'HUB',
                    isNative: false
                }
            }
        }
    };

    const setupEnvVars = (overrides: Partial<NodeJS.ProcessEnv> = {}) => {
        process.env = {
            INVOICE_AGE: '3600',
            SIGNER_URL: 'http://signer',
            EVERCLEAR_API_URL: 'http://everclear',
            SIGNER_ADDRESS: '0xsigner',
            SUPPORTED_SETTLEMENT_DOMAINS: '1,2',
            SUPPORTED_ASSETS: 'ETH,HUB',
            CHAIN_IDS: '1',
            ENVIRONMENT: 'mainnet',
            ...overrides
        };
    };

    beforeEach(() => {
        processEnvBackup = { ...process.env };
        axiosGetStub = stub(axios, 'axiosGet');
        axiosGetStub.resolves({ data: mockEverclearConfig });
        setupEnvVars();
    });

    afterEach(() => {
        process.env = processEnvBackup;
        axiosGetStub.restore();
    });

    describe('getEverclearConfig', () => {
        it('should fetch and return config', async () => {
            const config = await getEverclearConfig('http://config.url');
            expect(config).to.deep.equal(mockEverclearConfig);
            expect(axiosGetStub.calledOnceWith('http://config.url')).to.be.true;
        });

        it('should fallback to mainnet config if custom URL fails', async () => {
            axiosGetStub.onFirstCall().rejects(new Error('Failed'));
            axiosGetStub.onSecondCall().resolves({ data: mockEverclearConfig });
            const config = await getEverclearConfig('http://failing.url');
            expect(config).to.deep.equal(mockEverclearConfig);
            expect(axiosGetStub.secondCall.args[0]).to.equal(EVERCLEAR_MAINNET_CONFIG_URL);
        });

        it('should return undefined if all fetches fail', async () => {
            axiosGetStub.rejects(new Error('Failed'));
            const config = await getEverclearConfig();
            expect(config).to.be.undefined;
        });

        it('should use testnet URL in testnet environment', async () => {
            setupEnvVars({ ENVIRONMENT: 'testnet' });
            await getEverclearConfig(EVERCLEAR_TESTNET_CONFIG_URL);
            expect(axiosGetStub.calledWith(EVERCLEAR_TESTNET_CONFIG_URL)).to.be.true;
        });

        it('should handle missing data in response', async () => {
            axiosGetStub.resolves({});
            const config = await getEverclearConfig();
            expect(config).to.be.undefined;
        });

        it('should handle failed mainnet fallback', async () => {
            axiosGetStub.onFirstCall().rejects(new Error('Failed'));
            axiosGetStub.onSecondCall().resolves({});  // Mainnet fallback returns empty response
            const config = await getEverclearConfig('http://failing.url');
            expect(config).to.be.undefined;
        });
    });

    describe('loadConfiguration', () => {
        it('should load configuration with minimal env vars', async () => {
            const config = await loadConfiguration();
            expect(config).to.include({
                invoiceAge: 3600,
                web3SignerUrl: 'http://signer',
                everclearApiUrl: 'http://everclear',
                ownAddress: '0xsigner',
                environment: 'mainnet'
            });
            expect(config.supportedSettlementDomains).to.deep.equal([1, 2]);
            expect(config.supportedAssets).to.deep.equal(['ETH', 'HUB']);
        });

        it('should load configuration with custom chain providers', async () => {
            setupEnvVars({ CHAIN_1_PROVIDERS: 'http://custom.provider' });
            const config = await loadConfiguration();
            expect(config.chains['1'].providers).to.deep.equal(['http://custom.provider']);
        });

        it('should load configuration with relayer settings', async () => {
            setupEnvVars({
                RELAYER_URL: 'http://relayer',
                RELAYER_API_KEY: 'api-key'
            });
            const config = await loadConfiguration();
            expect(config.relayer).to.deep.equal({
                url: 'http://relayer',
                key: 'api-key'
            });
        });

        it('should handle custom chain assets', async () => {
            setupEnvVars({
                CHAIN_1_ASSETS: 'CUSTOM,0xaddr,6,CUSTOM,false;OTHER,0xother,18,OTHER,true',
                SUPPORTED_ASSETS: 'CUSTOM,OTHER'
            });
            const config = await loadConfiguration();
            expect(config.chains['1'].assets).to.deep.equal([
                {
                    symbol: 'CUSTOM',
                    address: '0xaddr',
                    decimals: 6,
                    tickerHash: 'CUSTOM',
                    isNative: false
                },
                {
                    symbol: 'OTHER',
                    address: '0xother',
                    decimals: 18,
                    tickerHash: 'OTHER',
                    isNative: true
                }
            ]);
        });

        it('should handle custom hub configuration', async () => {
            setupEnvVars({
                HUB_CHAIN: '1234',
                CHAIN_1234_PROVIDERS: 'http://custom.hub',
                CHAIN_1234_ASSETS: 'HUB,0xhub,18,HUB,false'
            });
            const config = await loadConfiguration();
            expect(config.hub).to.deep.equal({
                domain: '1234',
                providers: ['http://custom.hub'],
                assets: [{
                    symbol: 'HUB',
                    address: '0xhub',
                    decimals: 18,
                    tickerHash: 'HUB',
                    isNative: false
                }]
            });
        });

        it('should use default values for optional settings', async () => {
            setupEnvVars({
                ENVIRONMENT: 'local',
                LOG_LEVEL: 'info',
                STAGE: 'production'
            });
            const config = await loadConfiguration();
            expect(config).to.include({
                environment: 'local',
                logLevel: 'info',
                stage: 'production'
            });
        });

        it('should throw ConfigurationError for missing required env vars', async () => {
            const requiredVars = ['INVOICE_AGE', 'SIGNER_URL', 'EVERCLEAR_API_URL', 'SIGNER_ADDRESS', 'SUPPORTED_SETTLEMENT_DOMAINS', 'SUPPORTED_ASSETS', 'CHAIN_IDS'];

            for (const envVar of requiredVars) {
                setupEnvVars();
                delete process.env[envVar];
                await expect(loadConfiguration()).to.be.rejectedWith(ConfigurationError, /required/);
            }
        });

        it('should throw ConfigurationError for invalid configuration', async () => {
            // Test invalid invoice age
            setupEnvVars({ INVOICE_AGE: '0' });
            await expect(loadConfiguration()).to.be.rejectedWith(ConfigurationError, /Invalid invoice age/);
        });

        it('should throw ConfigurationError for empty settlement domains', async () => {
            setupEnvVars({
                SUPPORTED_SETTLEMENT_DOMAINS: '',
                CHAIN_IDS: '1',
                SUPPORTED_ASSETS: 'ETH'
            });
            try {
                await loadConfiguration();
                expect.fail('Should have thrown an error');
            } catch (error: unknown) {
                expect(error).to.be.instanceOf(ConfigurationError);
                if (error instanceof ConfigurationError) {
                    expect(error.message).to.include('Environment variable SUPPORTED_SETTLEMENT_DOMAINS is required');
                }
            }
        });

        it('should throw ConfigurationError for empty chain IDs', async () => {
            setupEnvVars({
                CHAIN_IDS: '',
                SUPPORTED_SETTLEMENT_DOMAINS: '1',
                SUPPORTED_ASSETS: 'ETH'
            });
            try {
                await loadConfiguration();
                expect.fail('Should have thrown an error');
            } catch (error: unknown) {
                expect(error).to.be.instanceOf(ConfigurationError);
                if (error instanceof ConfigurationError) {
                    expect(error.message).to.include('Environment variable CHAIN_IDS is required');
                }
            }
        });

        it('should throw ConfigurationError for missing signer URL', async () => {
            setupEnvVars();
            delete process.env.SIGNER_URL;
            await expect(loadConfiguration()).to.be.rejectedWith(ConfigurationError, /SIGNER_URL/);
        });

        it('should throw ConfigurationError for missing Everclear API URL', async () => {
            setupEnvVars();
            delete process.env.EVERCLEAR_API_URL;
            await expect(loadConfiguration()).to.be.rejectedWith(ConfigurationError, /EVERCLEAR_API_URL/);
        });

        it('should throw ConfigurationError for missing relayer API key', async () => {
            setupEnvVars({
                RELAYER_URL: 'http://relayer'
            });
            delete process.env.RELAYER_API_KEY;
            await expect(loadConfiguration()).to.be.rejectedWith(ConfigurationError, /RELAYER_API_KEY/);
        });

        it('should handle missing hosted config', async () => {
            axiosGetStub.resolves({});
            const config = await loadConfiguration();
            expect(config.chains['1'].providers).to.deep.equal([]);
        });
    });

    describe('token helpers', () => {
        let config: Awaited<ReturnType<typeof loadConfiguration>>;

        beforeEach(async () => {
            config = await loadConfiguration();
        });

        it('should get token address and decimals for valid assets', () => {
            expect(getTokenAddressFromConfig('ETH', '1', config)).to.equal('0xeth');
            expect(getDecimalsFromConfig('ETH', '1', config)).to.equal(18);
        });

        it('should handle case-insensitive ticker hash matching', () => {
            expect(getTokenAddressFromConfig('eth', '1', config)).to.equal('0xeth');
            expect(getDecimalsFromConfig('eth', '1', config)).to.equal(18);
        });

        it('should return undefined for invalid assets', () => {
            expect(getTokenAddressFromConfig('INVALID', '1', config)).to.be.undefined;
            expect(getDecimalsFromConfig('INVALID', '1', config)).to.be.undefined;
            expect(getTokenAddressFromConfig('ETH', '999', config)).to.be.undefined;
            expect(getDecimalsFromConfig('ETH', '999', config)).to.be.undefined;
        });

        it('should handle undefined chain assets', () => {
            const configWithoutAssets = {
                ...config,
                chains: {
                    ...config.chains,
                    '1': {
                        ...config.chains['1'],
                        assets: []
                    }
                }
            };
            expect(getTokenAddressFromConfig('ETH', '1', configWithoutAssets)).to.be.undefined;
            expect(getDecimalsFromConfig('ETH', '1', configWithoutAssets)).to.be.undefined;
        });
    });
});
