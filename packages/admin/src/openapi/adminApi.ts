import { z } from 'zod/v4';
import {
  CancelEarmarkRequest,
  CancelRebalanceOperationRequest,
  Earmark,
  EarmarkStatus,
  ErrorResponse,
  ForbiddenResponse,
  GetEarmarkDetailsResponse,
  GetEarmarksResponse,
  GetRebalanceOperationDetailsResponse,
  GetRebalanceOperationsResponse,
  RebalanceOperation,
  RebalanceOperationStatus,
  SuccessResponse,
  TriggerIntentRequest,
  TriggerIntentResponse,
  TriggerRebalanceRequest,
  TriggerRebalanceResponse,
  TriggerSendRequest,
  TriggerSendResponse,
  TriggerSwapRequest,
  TriggerSwapResponse,
} from './schemas';

export type HttpMethod = 'get' | 'post';

export type AdminApiEndpoint = {
  method: HttpMethod;
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  response: z.ZodTypeAny;
  /**
   * Override default error schemas when needed. If omitted, generator applies defaults.
   */
  errors?: Partial<Record<400 | 403 | 404 | 500, z.ZodTypeAny>>;
};

const PaginationQuery = z.object({
  limit: z.string().regex(/^\d+$/).optional().default('50'),
  offset: z.string().regex(/^\d+$/).optional().default('0'),
});

export const AdminApi = {
  pausePurchase: {
    method: 'post',
    path: '/pause/purchase',
    operationId: 'pausePurchase',
    summary: 'Pause purchase operations',
    description: 'Pauses all purchase cache operations.',
    tags: ['Purchase Operations'],
    response: SuccessResponse,
  },
  unpausePurchase: {
    method: 'post',
    path: '/unpause/purchase',
    operationId: 'unpausePurchase',
    summary: 'Unpause purchase operations',
    description: 'Resumes paused purchase cache operations.',
    tags: ['Purchase Operations'],
    response: SuccessResponse,
  },
  pauseRebalance: {
    method: 'post',
    path: '/pause/rebalance',
    operationId: 'pauseRebalance',
    summary: 'Pause rebalance operations',
    description: 'Pauses all rebalance operations.',
    tags: ['Rebalance Operations'],
    response: SuccessResponse,
  },
  unpauseRebalance: {
    method: 'post',
    path: '/unpause/rebalance',
    operationId: 'unpauseRebalance',
    summary: 'Unpause rebalance operations',
    description: 'Resumes paused rebalance operations.',
    tags: ['Rebalance Operations'],
    response: SuccessResponse,
  },
  pauseOnDemandRebalance: {
    method: 'post',
    path: '/pause/ondemand-rebalance',
    operationId: 'pauseOnDemandRebalance',
    summary: 'Pause on-demand rebalance operations',
    description: 'Pauses on-demand rebalance operations.',
    tags: ['Rebalance Operations'],
    response: SuccessResponse,
  },
  unpauseOnDemandRebalance: {
    method: 'post',
    path: '/unpause/ondemand-rebalance',
    operationId: 'unpauseOnDemandRebalance',
    summary: 'Unpause on-demand rebalance operations',
    description: 'Resumes paused on-demand rebalance operations.',
    tags: ['Rebalance Operations'],
    response: SuccessResponse,
  },
  getEarmarks: {
    method: 'get',
    path: '/rebalance/earmarks',
    operationId: 'getEarmarks',
    summary: 'List earmarks',
    description:
      'Retrieve a paginated list of earmarks with optional filtering. Each earmark includes a nested array of its associated operations.',
    tags: ['Earmarks'],
    query: PaginationQuery.extend({
      status: EarmarkStatus.optional(),
      chainId: z.string().regex(/^\d+$/).optional(),
      invoiceId: z.string().optional(),
    }),
    response: GetEarmarksResponse,
  },
  getEarmarkDetails: {
    method: 'get',
    path: '/rebalance/earmark/{id}',
    operationId: 'getEarmarkDetails',
    summary: 'Get earmark details',
    description: 'Retrieve detailed information about a specific earmark including its operations.',
    tags: ['Earmarks'],
    params: z.object({
      id: z.string().uuid(),
    }),
    response: GetEarmarkDetailsResponse,
    errors: {
      400: ErrorResponse,
      404: ErrorResponse,
    },
  },
  getRebalanceOperations: {
    method: 'get',
    path: '/rebalance/operations',
    operationId: 'getRebalanceOperations',
    summary: 'List rebalance operations',
    description: 'Retrieve a paginated list of rebalance operations with optional filtering.',
    tags: ['Rebalance Operations'],
    query: PaginationQuery.extend({
      status: RebalanceOperationStatus.optional(),
      chainId: z.string().regex(/^\d+$/).optional(),
      earmarkId: z.union([z.literal('null'), z.string().uuid()]).optional(),
      invoiceId: z.string().optional(),
    }),
    response: GetRebalanceOperationsResponse,
  },
  getRebalanceOperationDetails: {
    method: 'get',
    path: '/rebalance/operation/{id}',
    operationId: 'getRebalanceOperationDetails',
    summary: 'Get rebalance operation details',
    description: 'Retrieve a specific rebalance operation, including its transactions when available.',
    tags: ['Rebalance Operations'],
    params: z.object({
      id: z.string().uuid(),
    }),
    response: GetRebalanceOperationDetailsResponse,
    errors: {
      400: ErrorResponse,
      404: ErrorResponse,
    },
  },
  cancelEarmark: {
    method: 'post',
    path: '/rebalance/cancel',
    operationId: 'cancelEarmark',
    summary: 'Cancel earmark',
    description: 'Cancels an earmark and marks pending/awaiting_callback operations as orphaned.',
    tags: ['Earmarks'],
    body: CancelEarmarkRequest,
    response: z.object({ message: z.string(), earmark: Earmark }),
    errors: {
      400: ErrorResponse,
      404: ErrorResponse,
    },
  },
  cancelRebalanceOperation: {
    method: 'post',
    path: '/rebalance/operation/cancel',
    operationId: 'cancelRebalanceOperation',
    summary: 'Cancel rebalance operation',
    description: 'Cancels a pending rebalance operation (pending or awaiting_callback).',
    tags: ['Rebalance Operations'],
    body: CancelRebalanceOperationRequest,
    response: z.object({ message: z.string(), operation: RebalanceOperation }),
    errors: {
      400: ErrorResponse,
      404: ErrorResponse,
    },
  },
  triggerSend: {
    method: 'post',
    path: '/trigger/send',
    operationId: 'triggerSend',
    summary: 'Trigger token send',
    description: 'Submits an ERC20 transfer transaction from Mark ownAddress to a whitelisted recipient.',
    tags: ['Trigger Operations'],
    body: TriggerSendRequest,
    response: TriggerSendResponse,
    errors: {
      403: ForbiddenResponse,
      400: ErrorResponse,
      500: ErrorResponse,
    },
  },
  triggerRebalance: {
    method: 'post',
    path: '/trigger/rebalance',
    operationId: 'triggerRebalance',
    summary: 'Trigger rebalance operation',
    description: 'Builds and submits rebalance transactions via the selected bridge adapter and records the operation.',
    tags: ['Trigger Operations'],
    body: TriggerRebalanceRequest,
    response: TriggerRebalanceResponse,
    errors: {
      400: ErrorResponse,
      500: ErrorResponse,
    },
  },
  triggerIntent: {
    method: 'post',
    path: '/trigger/intent',
    operationId: 'triggerIntent',
    summary: 'Trigger Everclear intent',
    description:
      'Creates and submits an Everclear intent transaction. Safety constraints enforced: maxFee=0 and callData=0x.',
    tags: ['Trigger Operations'],
    body: TriggerIntentRequest,
    response: TriggerIntentResponse,
    errors: {
      400: ErrorResponse,
      500: ErrorResponse,
    },
  },
  triggerSwap: {
    method: 'post',
    path: '/trigger/swap',
    operationId: 'triggerSwap',
    summary: 'Trigger swap',
    description: 'Executes a same-chain swap via a supported adapter (defaults to cowswap).',
    tags: ['Trigger Operations'],
    body: TriggerSwapRequest,
    response: TriggerSwapResponse,
    errors: {
      400: ErrorResponse,
      500: ErrorResponse,
    },
  },
} as const satisfies Record<string, AdminApiEndpoint>;

export type AdminApiKey = keyof typeof AdminApi;
export type AdminEndpoint = (typeof AdminApi)[AdminApiKey];
