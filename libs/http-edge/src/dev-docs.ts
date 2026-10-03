import { isProductionEnvironment } from '@arthome-platform/config';
import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type SecuritySchemeObject,
  type SwaggerDocumentOptions,
} from '@nestjs/swagger';
import { z } from 'zod';

import type { Api } from '@arthome/contracts/http';

import { requirementObjectOf } from './security-requirement.js';

type SchemaConverter = NonNullable<SwaggerDocumentOptions['standardSchemaConverter']>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Converts a contract's zod schema with the api's named schemas registered, so each is written
 *   once under `components.schemas` and referenced, as the contract's own document does. What zod
 *   cannot represent (the refusal of an undeclared query key) is left open rather than refused.
 */
export function contractSchemaConverter(api: Api): SchemaConverter {
  const names = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(api.components.schemas ?? {}))
    names.add(schema, { id });
  return (schema, { schemaType }) => {
    if (!(schema instanceof z.ZodType)) return undefined;
    const {
      $schema: _dialect,
      definitions: components,
      ...jsonSchema
    } = z.toJSONSchema(schema, {
      target: 'openapi-3.0',
      io: schemaType,
      metadata: names,
      unrepresentable: 'any',
    });
    return {
      schema: jsonSchema,
      ...(isRecord(components) && { components }),
    };
  };
}

export interface DevDocsOptions {
  /** What the page is called: the service's, not the api's, which is the whole surface's. */
  readonly title: string;
  readonly description?: string;
  /** Where the page is mounted; the document is served beside it, at `<path>-json`. */
  readonly path: string;
  /** The process environment by default; a suite passes its own. */
  readonly environment?: Record<string, string | undefined>;
}

/**
 * Mounts the Swagger UI for the routes this service binds to `api`, in development only: in
 *   production neither the page nor its raw document (`ui: false` alone still serves
 *   `<path>-json`) is registered. The document is built from the controllers, so it holds exactly
 *   the operations this service serves, under the api's servers and security schemes.
 */
export function mountDevDocs(
  app: INestApplication,
  api: Api,
  { title, description, path, environment = process.env }: DevDocsOptions,
): void {
  if (isProductionEnvironment(environment)) return;
  SwaggerModule.setup(path, app, (): OpenAPIObject => {
    const builder = new DocumentBuilder().setTitle(title).setVersion(String(api.info.version));
    if (description !== undefined) builder.setDescription(description);
    for (const server of api.servers ?? []) {
      builder.addServer(String(server.url), server.description as string | undefined);
    }
    for (const [name, scheme] of Object.entries(api.components.securitySchemes ?? {})) {
      builder.addSecurity(name, scheme as SecuritySchemeObject);
    }
    for (const requirement of api.security ?? []) {
      builder.addSecurityRequirements(requirementObjectOf(requirement));
    }
    return SwaggerModule.createDocument(app, builder.build(), {
      autoTagControllers: false,
      standardSchemaConverter: contractSchemaConverter(api),
    });
  });
}
