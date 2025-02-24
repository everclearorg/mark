import { EverclearAdapter } from "../src";
import { Logger } from '@mark/logger';

// mock logger
jest.mock('@mark/logger', () => {
    return {
        jsonifyError: jest.fn(),
        Logger: jest.fn().mockImplementation(() => ({
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn(),
            logger: {}
        }))
    };
});

describe.skip('EverclearAdapter', () => {
    const apiUrl = 'https://local.everclear.org';

    let adapter: EverclearAdapter;
    let logger: Logger;

    beforeEach(() => {
        logger = new Logger({ service: 'test-service' });
        adapter = new EverclearAdapter(apiUrl, logger)
    })

    describe('getMinAmounts', () => {
        it('should handle undefined cases', async () => {
            const invoiceId = '0xinvoice';
            const response = await adapter.getMinAmounts(invoiceId);
            expect(response).toBeDefined;
        })
    })
})