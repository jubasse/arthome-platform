import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ApiErrorCode, LanguageDependency, rendition } from '@arthome/core';

import { CatalogController } from './catalog.controller.js';
import type { PublishShowCommand, PublishShowService } from './publish-show.service.js';

/** A service that records the command it was handed, and publishes nothing. */
function recordingService(commands: PublishShowCommand[]): PublishShowService {
  return {
    publish: (command: PublishShowCommand) => {
      commands.push(command);
      return Promise.resolve({ showId: 'show-1', messageId: 'message-1' });
    },
  } as unknown as PublishShowService;
}

const body = {
  channelId: 'channel-1',
  artistId: 'artist-1',
  categoryId: 'theatre',
  genreIds: ['contemporary'],
  tagIds: [],
  runtimeMin: 95,
  languageDependency: LanguageDependency.ESSENTIAL as string,
  spokenLanguages: ['fr'],
  subtitleLanguages: [],
  surtitleLanguages: [],
  media: {
    wide: [rendition('https://cdn.example.test/w-640.jpg', 640, 360)],
    poster: [rendition('https://cdn.example.test/p-480.jpg', 480, 720)],
  },
};

describe('CatalogController', () => {
  it('refuses a language dependency that is not a member, before anything is written', async () => {
    const commands: PublishShowCommand[] = [];
    const controller = new CatalogController(recordingService(commands));

    // `light` is the value `taxonomy.json` declares and the domain dropped (D1).
    // It is exactly the plausible-looking input this guard exists for.
    await expect(controller.publish({ ...body, languageDependency: 'light' })).rejects.toThrow(
      BadRequestException,
    );

    // The refusal is the point, but so is WHERE it happens: nothing reached the
    // transaction, so no show row and no outbox row were written.
    expect(commands).toHaveLength(0);
  });

  it('refuses with a code and its params, never a sentence', async () => {
    const controller = new CatalogController(recordingService([]));

    await expect(
      controller.publish({ ...body, languageDependency: 'light' }),
    ).rejects.toMatchObject({
      // critical-rules #8: an error carries a code. An English message reaching
      // a screen leaks i18n from the first form error onwards.
      response: { code: ApiErrorCode.SCHEMA_INVALID, params: { field: 'languageDependency' } },
    });
  });

  it('carries the traceparent the request arrived with', async () => {
    const commands: PublishShowCommand[] = [];
    const controller = new CatalogController(recordingService(commands));
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    await controller.publish(body, traceparent);
    expect(commands[0]?.traceparent).toBe(traceparent);
  });

  it('carries null rather than an empty traceparent when the header is absent', async () => {
    const commands: PublishShowCommand[] = [];
    const controller = new CatalogController(recordingService(commands));

    const result = await controller.publish(body);
    expect(commands[0]?.traceparent).toBeNull();
    expect(result.showId).toBe('show-1');
  });
});
