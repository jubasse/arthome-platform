import { RefusalException, schemaInvalidException } from '@arthome-platform/http-edge';
import { StandardSchemaValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode, FailureNature, LanguageDependency, rendition } from '@arthome/core';

import { PublishShowSchema } from './publish-show.schema.js';

/** The pipe as `AppModule` binds it: a schema without it validates nothing. */
const pipe = new StandardSchemaValidationPipe({ exceptionFactory: schemaInvalidException });

const metadata = { type: 'body', schema: PublishShowSchema } as const satisfies ArgumentMetadata;

const body = {
  channelId: 'channel-1',
  artistId: 'artist-1',
  categoryId: 'theatre',
  genreIds: ['contemporary'],
  tagIds: [],
  runtimeMin: 95,
  languageDependency: LanguageDependency.ESSENTIAL,
  spokenLanguages: ['fr'],
  subtitleLanguages: [],
  surtitleLanguages: [],
  media: {
    wide: [rendition('https://cdn.example.test/w-640.jpg', 640, 360)],
    poster: [rendition('https://cdn.example.test/p-480.jpg', 480, 720)],
  },
};

async function refusalFor(candidate: unknown): Promise<RefusalException> {
  try {
    await pipe.transform(candidate, metadata);
  } catch (error: unknown) {
    if (error instanceof RefusalException) {
      return error;
    }
    throw error;
  }
  throw new Error('the body was accepted, and this case exists because it must not be');
}

describe('the POST /shows body', () => {
  it('accepts a well-formed publication', async () => {
    await expect(pipe.transform(body, metadata)).resolves.toEqual(body);
  });

  it('refuses genreIds sent as a string, which used to invent three genres nobody sent', async () => {
    // THE CASE THIS FILE EXISTS FOR. `publish-show.service.ts` spreads the value
    //   twice — once into the event, once into the row — and spreading `'abc'`
    //   yields `['a','b','c']`. Three genre ids the caller never sent were
    //   committed, published in `ShowPublished.genre_ids`, and indexed, with no
    //   error at any hop.
    const refusal = await refusalFor({ ...body, genreIds: 'abc' });

    expect(refusal.getStatus()).toBe(400);
    expect(refusal.refusal.params).toEqual({ fields: ['genreIds'] });
  });

  it('refuses a genre id that is not a slug', async () => {
    // Checked against the real ids, not assumed: core's taxonomy uses `theatre`,
    // `contemporary`, `ballet-classique`, `open-air` — all slugs.
    await expect(refusalFor({ ...body, genreIds: ['Contemporary'] })).resolves.toBeDefined();
    await expect(refusalFor({ ...body, genreIds: [42] })).resolves.toBeDefined();
  });

  it('refuses a language dependency that is not a member, before anything is written', async () => {
    // `light` is the value `taxonomy.json` declares and the domain dropped (D1) —
    // exactly the plausible-looking input this guard exists for. It used to be
    // checked with `isMember` in the controller; it is now `vocabularyIn`, which
    // that controller's own comment named as the proper `In` form.
    const refusal = await refusalFor({ ...body, languageDependency: 'light' });
    expect(refusal.refusal.params).toEqual({ fields: ['languageDependency'] });
  });

  it('refuses a language dependency of the wrong type, which would have published UNSPECIFIED', async () => {
    // A Protobuf enum: an unknown member has no number, so the silent outcome is
    // `LANGUAGE_DEPENDENCY_UNSPECIFIED` — a published fact saying nothing about the
    // field `hasLanguageBarrier` reads.
    await expect(refusalFor({ ...body, languageDependency: 7 })).resolves.toBeDefined();
  });

  it('refuses a runtime the wire cannot carry, turning a rollback into a refusal', async () => {
    // MEASURED, AND IT CORRECTS WHAT HANDOVER.md USED TO CLAIM. `runtime_min` is
    //   `uint32`, and `assertUInt32` throws on a negative, a non-integer and a
    //   non-number — inside the transaction, so `-1` already rolled back with a 500
    //   and published nothing. The fix is not that it was silent; it is that a 500
    //   was the wrong answer to a bad request.
    await expect(refusalFor({ ...body, runtimeMin: -1 })).resolves.toBeDefined();
    await expect(refusalFor({ ...body, runtimeMin: 95.5 })).resolves.toBeDefined();
    await expect(refusalFor({ ...body, runtimeMin: 2 ** 32 })).resolves.toBeDefined();
    await expect(refusalFor({ ...body, runtimeMin: '95' })).resolves.toBeDefined();
  });

  it('refuses a rendition dimension that is not a number, and leaves the rule to the domain', async () => {
    // The schema checks that the numbers ARE numbers; `rendition()` checks that
    // they are positive integers, with `media.size_invalid`. Two calls, one
    // implementation (critical-rules #2).
    await expect(
      refusalFor({
        ...body,
        media: { ...body.media, wide: [{ url: 'x', widthPx: '640', heightPx: 360 }] },
      }),
    ).resolves.toBeDefined();
  });

  it('refuses an unknown field rather than dropping it', async () => {
    const refusal = await refusalFor({ ...body, isFeatured: true });
    expect(refusal.refusal.code).toBe(ApiErrorCode.SCHEMA_INVALID);
  });

  it('names every field that failed, sorted, and not one word of the validation library', async () => {
    const refusal = await refusalFor({ ...body, genreIds: 'abc', categoryId: 9, runtimeMin: -1 });

    expect(refusal.refusal.params).toEqual({
      fields: ['categoryId', 'genreIds', 'runtimeMin'],
    });
    expect(refusal.refusal.code).toBe(ApiErrorCode.SCHEMA_INVALID);
    expect(refusal.refusal.nature).toBe(FailureNature.REFUSED);
    expect(JSON.stringify(refusal.refusal)).not.toMatch(/invalid input|expected|received/i);
  });

  it('accepts an empty media set, because the entity requires the keys and not the images', async () => {
    await expect(
      pipe.transform({ ...body, media: { wide: [], poster: [] } }, metadata),
    ).resolves.toBeDefined();
    // Both keys are required though: `MediaSet` declares both and the column is NOT NULL.
    await expect(refusalFor({ ...body, media: { wide: [] } })).resolves.toBeDefined();
  });
});
