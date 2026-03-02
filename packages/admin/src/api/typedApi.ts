import type { z } from 'zod/v4';
import { z as zod } from 'zod/v4';
import { ErrorResponse } from '../openapi/schemas';

export type LambdaResponse = { statusCode: number; body: string };

export function jsonWithSchema<T extends z.ZodTypeAny>(
  statusCode: number,
  schema: T,
  payload: z.input<T>,
): { statusCode: number; body: string } {
  const jsonSafePayload = JSON.parse(JSON.stringify(payload)) as unknown;
  const parsed = schema.parse(jsonSafePayload) as z.output<T>;
  return {
    statusCode,
    body: JSON.stringify(parsed),
  };
}

export function isLambdaResponse(value: unknown): value is LambdaResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'statusCode' in value &&
    'body' in value &&
    typeof (value as { statusCode: unknown }).statusCode === 'number' &&
    typeof (value as { body: unknown }).body === 'string'
  );
}

export function parseJsonBody<T extends z.ZodTypeAny>(schema: T, rawBody: string | null): z.output<T> | LambdaResponse {
  let parsedJson: unknown;
  try {
    parsedJson = rawBody ? JSON.parse(rawBody) : {};
  } catch (e) {
    return jsonWithSchema(400, ErrorResponse, {
      message: 'Validation failed: request body is not valid JSON',
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const result = (schema as zod.ZodType).safeParse(parsedJson);
  if (!result.success) {
    return jsonWithSchema(400, ErrorResponse, {
      message: 'Validation failed: request body did not match schema',
      error: zod.prettifyError(result.error),
    });
  }
  return result.data as z.output<T>;
}

export function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  rawQuery: Record<string, string | undefined> | null,
): z.output<T> | LambdaResponse {
  const queryObj = rawQuery ?? {};
  const result = (schema as zod.ZodType).safeParse(queryObj);
  if (!result.success) {
    return jsonWithSchema(400, ErrorResponse, {
      message: 'Validation failed: query parameters did not match schema',
      error: zod.prettifyError(result.error),
    });
  }
  return result.data as z.output<T>;
}

export function parsePathParams<T extends z.ZodTypeAny>(
  schema: T,
  rawParams: Record<string, string | undefined> | null,
): z.output<T> | LambdaResponse {
  const paramsObj = rawParams ?? {};
  const result = (schema as zod.ZodType).safeParse(paramsObj);
  if (!result.success) {
    return jsonWithSchema(400, ErrorResponse, {
      message: 'Validation failed: path parameters did not match schema',
      error: zod.prettifyError(result.error),
    });
  }
  return result.data as z.output<T>;
}
