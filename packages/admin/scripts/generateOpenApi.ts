import fs from 'fs';
import path from 'path';
import * as YAML from 'yaml';
import { toJSONSchema, z } from 'zod/v4';

import { AdminApi, type AdminApiEndpoint } from '../src/openapi/adminApi';
import { ErrorResponse, ForbiddenResponse, SuccessResponse } from '../src/openapi/schemas';

type JsonSchema = Record<string, unknown>;

function zodToOpenApiSchema(schema: z.ZodTypeAny): JsonSchema {
  const jsonSchema = toJSONSchema(schema, { target: 'draft-2020-12' }) as JsonSchema;
  // OpenAPI schema objects should not embed their own $schema URI.
  // (OpenAPI 3.1 declares the dialect at the document level.)
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete (jsonSchema as any).$schema;
  return jsonSchema;
}

function schemaToParameters(schema: z.ZodTypeAny, location: 'path' | 'query'): Array<Record<string, unknown>> {
  const jsonSchema = zodToOpenApiSchema(schema);
  if (jsonSchema.type !== 'object') return [];

  const properties = (jsonSchema.properties ?? {}) as Record<string, unknown>;
  const required = new Set<string>(Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : []);

  return Object.entries(properties).map(([name, propSchema]) => ({
    name,
    in: location,
    required: location === 'path' ? true : required.has(name),
    schema: propSchema,
  }));
}

function main() {
  const paths: Record<string, any> = {};

  for (const endpoint of Object.values(AdminApi) as AdminApiEndpoint[]) {
    const parameters = [
      ...(endpoint.params ? schemaToParameters(endpoint.params, 'path') : []),
      ...(endpoint.query ? schemaToParameters(endpoint.query, 'query') : []),
    ];

    const requestBody = endpoint.body
      ? {
          required: true,
          content: {
            'application/json': { schema: zodToOpenApiSchema(endpoint.body) },
          },
        }
      : undefined;

    const errorSchemas = {
      400: endpoint.errors?.[400] ?? ErrorResponse,
      403: endpoint.errors?.[403] ?? ForbiddenResponse,
      404: endpoint.errors?.[404] ?? ErrorResponse,
      500: endpoint.errors?.[500] ?? ErrorResponse,
    };

    const responses: Record<string, any> = {
      200: {
        description: 'Successful response',
        content: {
          'application/json': { schema: zodToOpenApiSchema(endpoint.response) },
        },
      },
    };

    const errorStatusCodes = new Set<number>([403, 500]);
    if (endpoint.body || endpoint.params || endpoint.query) errorStatusCodes.add(400);
    if (endpoint.path.includes('{')) {
      errorStatusCodes.add(400);
      errorStatusCodes.add(404);
    }
    for (const code of Object.keys(endpoint.errors ?? {})) {
      errorStatusCodes.add(Number(code));
    }

    if (errorStatusCodes.has(400)) {
      responses[400] = {
        description: 'Bad Request',
        content: { 'application/json': { schema: zodToOpenApiSchema(errorSchemas[400]) } },
      };
    }
    if (errorStatusCodes.has(403)) {
      responses[403] = {
        description: 'Forbidden',
        content: { 'application/json': { schema: zodToOpenApiSchema(errorSchemas[403]) } },
      };
    }
    if (errorStatusCodes.has(404)) {
      responses[404] = {
        description: 'Not Found',
        content: { 'application/json': { schema: zodToOpenApiSchema(errorSchemas[404]) } },
      };
    }
    if (errorStatusCodes.has(500)) {
      responses[500] = {
        description: 'Internal Server Error',
        content: { 'application/json': { schema: zodToOpenApiSchema(errorSchemas[500]) } },
      };
    }

    const operation: Record<string, any> = {
      tags: endpoint.tags,
      summary: endpoint.summary,
      description: endpoint.description,
      operationId: endpoint.operationId,
      parameters: parameters.length ? parameters : undefined,
      requestBody,
      responses,
    };

    if (!paths[endpoint.path]) paths[endpoint.path] = {};
    paths[endpoint.path][endpoint.method] = operation;
  }

  const document: Record<string, any> = {
    openapi: '3.1.0',
    info: {
      title: 'Mark Admin API',
      version: '1.0.0',
      description: 'Mark Admin API schema (auto-generated from Zod schemas).',
      contact: { name: 'Everclear Team' },
    },
    servers: [{ url: 'https://admin.api.everclear.org', description: 'Production server' }],
    security: [{ AdminToken: [] }],
    tags: [
      { name: 'Purchase Operations', description: 'Endpoints for managing purchase cache operations' },
      { name: 'Rebalance Operations', description: 'Endpoints for managing rebalance operations and state' },
      { name: 'Earmarks', description: 'Endpoints for managing earmarks and related operations' },
      { name: 'Trigger Operations', description: 'Endpoints for manually triggering operations (send, rebalance, intent, swap)' },
    ],
    components: {
      securitySchemes: {
        AdminToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-admin-token',
          description: 'Admin token required for all admin endpoints.',
        },
      },
      schemas: {
        SuccessResponse: zodToOpenApiSchema(SuccessResponse),
        ErrorResponse: zodToOpenApiSchema(ErrorResponse),
        ForbiddenResponse: zodToOpenApiSchema(ForbiddenResponse),
      },
    },
    paths,
  };

  const outPath = path.resolve(__dirname, '..', 'openapi.yaml');
  const header = '# GENERATED FILE. DO NOT EDIT BY HAND.\n# Regenerate with: yarn workspace @mark/admin generate:openapi\n';
  fs.writeFileSync(outPath, header + YAML.stringify(document), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`✅ OpenAPI schema generated -> ${outPath}`);
}

if (require.main === module) {
  main();
}
