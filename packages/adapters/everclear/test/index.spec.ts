import { expect } from "chai"
import sinon from 'sinon'
import { EverclearAdapter, Invoice } from '../src'
import { Logger } from '@mark/logger'
import { ChainConfiguration, NewIntentParams, TransactionRequest, AssetConfiguration } from '@mark/core'
import chaiAsPromised from 'chai-as-promised'
import chai from 'chai'
import { AxiosResponse } from 'axios'
import proxyquire from 'proxyquire'

chai.use(chaiAsPromised)

describe('EverclearAdapter', () => {
    let adapter: EverclearAdapter
    let logger: Logger
    let sandbox: sinon.SinonSandbox
    let axiosGetStub: sinon.SinonStub
    let axiosPostStub: sinon.SinonStub
    const API_URL = 'https://api.example.com'

    beforeEach(() => {
        sandbox = sinon.createSandbox()

        logger = {
            info: sandbox.stub(),
            error: sandbox.stub(),
            warn: sandbox.stub(),
            debug: sandbox.stub(),
        } as unknown as Logger

        axiosGetStub = sandbox.stub()
        axiosPostStub = sandbox.stub()

        const stubs = {
            '@mark/core': {
                axiosGet: axiosGetStub,
                axiosPost: axiosPostStub,
                '@noCallThru': true
            }
        }

        const { EverclearAdapter: ProxiedAdapter } = proxyquire('../src', stubs)
        adapter = new ProxiedAdapter(API_URL, logger)
    })

    afterEach(() => {
        sandbox.restore()
    })

    describe('fetchInvoices', () => {
        const mockInvoices: Invoice[] = [{
            intent_id: '0x123',
            owner: '0xabc',
            entry_epoch: 123,
            amount: '1000',
            discountBps: 1.0,
            origin: '1',
            destinations: ['8453'],
            hub_status: 'INVOICED',
            ticker_hash: '0xdef',
            hub_invoice_enqueued_timestamp: 1234567890
        }]

        it('should fetch invoices successfully with destinations', async () => {
            const mockAsset: AssetConfiguration = {
                symbol: 'TEST',
                address: '0x123',
                decimals: 18,
                tickerHash: '0xdef',
                isNative: false
            }

            const destinations: Record<string, ChainConfiguration> = {
                '8453': {
                    providers: ['http://example.com'],
                    assets: [mockAsset]
                }
            }

            const mockAxiosResponse: AxiosResponse = {
                data: { invoices: mockInvoices },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as any
            }

            axiosGetStub.resolves(mockAxiosResponse)

            const result = await adapter.fetchInvoices(destinations)

            expect(result).to.deep.equal(mockInvoices)
            sinon.assert.calledWith(
                axiosGetStub,
                `${API_URL}/invoices`,
                { params: { destinations: ['8453'] } }
            )
        })

        it('should fetch invoices successfully without destinations', async () => {
            const mockAxiosResponse: AxiosResponse = {
                data: { invoices: mockInvoices },
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as any
            }

            axiosGetStub.resolves(mockAxiosResponse)

            const result = await adapter.fetchInvoices({})

            expect(result).to.deep.equal(mockInvoices)
            sinon.assert.calledWith(
                axiosGetStub,
                `${API_URL}/invoices`,
                { params: {} }
            )
        })

        it('should handle API errors gracefully', async () => {
            const error = new Error('API Error')
            axiosGetStub.rejects(error)

            await expect(adapter.fetchInvoices({})).to.be.rejectedWith(error)
        })
    })

    describe('createNewIntent', () => {
        const mockParams: NewIntentParams = {
            to: '0xdef',
            inputAsset: '0x123',
            amount: '1000',
            origin: '1',
            destinations: ['8453'],
            callData: '0x',
            maxFee: '1000'
        }

        const mockResponse: TransactionRequest = {
            to: '0xdef',
            data: '0x123',
            value: '0',
            chainId: 1
        }

        it('should create new intent successfully', async () => {
            const mockAxiosResponse: AxiosResponse = {
                data: mockResponse,
                status: 200,
                statusText: 'OK',
                headers: {},
                config: {} as any
            }

            axiosPostStub.resolves(mockAxiosResponse)

            const result = await adapter.createNewIntent(mockParams)

            expect(result).to.deep.equal(mockResponse)
            sinon.assert.calledWith(
                axiosPostStub,
                `${API_URL}/intents`,
                mockParams
            )
        })

        it('should handle API errors appropriately', async () => {
            axiosPostStub.rejects(new Error('API Error'))

            await expect(adapter.createNewIntent(mockParams))
                .to.be.rejectedWith('Failed to fetch create intent from API')
        })
    })

    describe('updateInvoiceStatus', () => {
        it('should throw not implemented error', async () => {
            await expect(adapter.updateInvoiceStatus())
                .to.be.rejectedWith('Not implemented')
        })
    })
})