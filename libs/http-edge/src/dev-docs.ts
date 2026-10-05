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
import { documentationLookup, type ApiDocs } from '@arthome/contracts/openapi';

import { requirementObjectOf } from './security-requirement.js';

type SchemaConverter = NonNullable<SwaggerDocumentOptions['standardSchemaConverter']>;

type OperationObject = NonNullable<OpenAPIObject['paths'][string]['get']>;

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
  /** The api's docs module (`@arthome/contracts/<api>/docs`): its introduction, servers, schemes and each operation's prose. */
  readonly docs: ApiDocs;
  /** What the page is called when it is not the api's: a service serves a part of its api. */
  readonly title?: string;
  /** Where the page is mounted; the document is served beside it, at `<path>-json`. */
  readonly path: string;
  /** The process environment by default; a suite passes its own. */
  readonly environment?: Record<string, string | undefined>;
}

const OPERATION_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Each bound operation's prose and doc-only `x-arthome-*`, as the api's docs module registers them. */
function withOperationDocs(document: OpenAPIObject, api: Api, docs: ApiDocs): OpenAPIObject {
  const documentationOf = documentationLookup(docs);
  const paths = Object.fromEntries(
    Object.entries(document.paths).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item).map(([key, value]) => {
          const operation = (OPERATION_METHODS as readonly string[]).includes(key)
            ? (value as OperationObject)
            : undefined;
          const route =
            operation?.operationId === undefined ? undefined : api.routes[operation.operationId];
          return [key, route === undefined ? value : { ...operation, ...documentationOf(route) }];
        }),
      ),
    ]),
  );
  return { ...document, paths };
}

/**
 * Mounts the Swagger UI for the routes this service binds to `api`, in development only: in
 *   production neither the page nor its raw document (`ui: false` alone still serves
 *   `<path>-json`) is registered. The document is built from the controllers, so it holds exactly
 *   the operations this service serves, under the docs' introduction, servers and security
 *   schemes, each operation with the prose its module registers.
 */
export function mountDevDocs(
  app: INestApplication,
  api: Api,
  { docs, title, path, environment = process.env }: DevDocsOptions,
): void {
  if (isProductionEnvironment(environment)) return;
  SwaggerModule.setup(path, app, (): OpenAPIObject => {
    const builder = new DocumentBuilder();
    const pageTitle = title ?? textOf(docs.info?.title);
    if (pageTitle !== undefined) builder.setTitle(pageTitle);
    const version = textOf(docs.info?.version);
    if (version !== undefined) builder.setVersion(version);
    const description = textOf(docs.info?.description);
    if (description !== undefined) builder.setDescription(description);
    for (const server of docs.servers ?? []) {
      const url = textOf(server.url);
      if (url !== undefined) builder.addServer(url, textOf(server.description));
    }
    for (const tag of docs.tags ?? []) {
      const name = textOf(tag.name);
      if (name !== undefined) builder.addTag(name, textOf(tag.description));
    }
    for (const [name, scheme] of Object.entries(docs.securitySchemes ?? {})) {
      builder.addSecurity(name, scheme as SecuritySchemeObject);
    }
    for (const requirement of api.security ?? []) {
      builder.addSecurityRequirements(requirementObjectOf(requirement));
    }
    const document = SwaggerModule.createDocument(app, builder.build(), {
      autoTagControllers: false,
      standardSchemaConverter: contractSchemaConverter(api),
    });
    return withOperationDocs(document, api, docs);
  });
}
