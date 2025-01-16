import { v4 as uuid } from 'uuid';
import { RequestContext } from './types';

export const createLoggingContext = (method: string, context?: RequestContext) => {
  return {
    requestContext: context ?? { id: uuid() },
    methodContext: { method },
  };
};
