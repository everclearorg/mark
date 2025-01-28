import { expect } from 'chai';
import * as sinon from 'sinon';
import { v4 as uuid } from 'uuid';
import { createLoggingContext } from '../src/logging';
import { RequestContext } from '../src/types';

describe('createLoggingContext', () => {
    it('should create logging context with provided method and context', () => {
        const method = 'testMethod';
        const context: RequestContext = { id: 'existing-id' };

        const result = createLoggingContext(method, context);

        expect(result).to.deep.equal({
            requestContext: { id: 'existing-id' },
            methodContext: { method: 'testMethod' },
        });
    });

    it('should create logging context with generated uuid when no context is provided', () => {
        const method = 'testMethod';

        const result = createLoggingContext(method);

        expect(result).to.containSubset({
            methodContext: { method: 'testMethod' },
        });
        expect(result.requestContext.id).to.be.ok;
    });
}); 