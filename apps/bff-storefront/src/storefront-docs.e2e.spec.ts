import { serveEndpoints } from '@arthome-platform/http-edge';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { storefrontApi } from '@arthome/contracts/storefront-api';
import { storefrontDocs, storefrontDocsOf } from '@arthome/contracts/storefront-api/docs';

import { AppModule } from './app.module.js';
import { CATALOG_URL } from './catalog/catalog.client.js';
import { mountStorefrontDocs } from './storefront-docs.js';

interface SwaggerDocument {
  readonly info: Readonly<Record<string, unknown>>;
  readonly servers: readonly unknown[];
  readonly paths: Readonly<Record<string, Readonly<Record<string, object>>>>;
  readonly components: { readonly securitySchemes: Readonly<Record<string, unknown>> };
}

let app: NestFastifyApplication;
let document: SwaggerDocument;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CATALOG_URL)
    .useValue('http://localhost:1')
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    logger: false,
  });
  serveEndpoints(app);
  mountStorefrontDocs(app, { NODE_ENV: 'development' });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  document = (await app.inject({ method: 'GET', url: '/docs-json' })).json<SwaggerDocument>();
});

afterAll(async () => {
  await app.close();
});

describe('the storefront BFF’s development documentation', () => {
  it('opens on the contract’s introduction, servers and security schemes', () => {
    expect(document.info).toMatchObject({
      title: storefrontDocs.info?.title,
      version: storefrontDocs.info?.version,
      description: storefrontDocs.info?.description,
    });
    expect(document.servers).toEqual(storefrontDocs.servers);
    expect(Object.keys(document.components.securitySchemes).sort()).toEqual(
      Object.keys(storefrontDocs.securitySchemes ?? {}).sort(),
    );
  });

  it('documents each bound operation from the contract’s docs', () => {
    const { search, getDateDetail, signIn } = storefrontApi.routes;

    expect(document.paths['/v1/search']?.get).toMatchObject(storefrontDocsOf(search));
    expect(document.paths['/v1/dates/{dateId}']?.get).toMatchObject(
      storefrontDocsOf(getDateDetail),
    );
    expect(document.paths['/v1/auth/sign-in']?.post).toMatchObject(storefrontDocsOf(signIn));
    expect(storefrontDocsOf(search).description).toBeDefined();
  });
});
