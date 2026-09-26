import { describe, expect, it } from 'vitest';

import { DomainErrorCode, LanguageDependency, isDomainError, rendition } from '@arthome/core';

import { CatalogController } from './catalog.controller.js';
import type { PublishShowBody } from './publish-show.schema.js';
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

const body: PublishShowBody = {
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
  title: { fr: 'Nuit blanche', en: 'White night' },
  synopsis: { fr: '', en: '' },
};

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('CatalogController', () => {
  it('carries the traceparent the request arrived with', async () => {
    const commands: PublishShowCommand[] = [];
    const controller = new CatalogController(recordingService(commands));

    await controller.publish(body, TRACEPARENT);
    expect(commands[0]?.traceparent).toBe(TRACEPARENT);
  });

  it('carries null rather than an empty traceparent when the header is absent', async () => {
    const commands: PublishShowCommand[] = [];
    const controller = new CatalogController(recordingService(commands));

    const result = await controller.publish(body);
    expect(commands[0]?.traceparent).toBeNull();
    expect(result.showId).toBe('show-1');
  });

  it('publishes anyway when the traceparent is malformed, carrying none', async () => {
    // BOTH HALVES MATTER, AND THE FIRST IS THE DECIDED ONE: a broken trace is an
    //   observability fault, never a business one, so the publication MUST still
    //   happen. The second is why the check exists — the value would otherwise
    //   reach `outbox_event.tracecontext`, the one outbox column with no CHECK
    //   constraint, and from there a Kafka header on `arthome.catalog.show`.
    const commands: PublishShowCommand[] = [];
    const controller = new CatalogController(recordingService(commands));

    const result = await controller.publish(body, '00-not-hex-00f067aa0ba902b7-01');

    expect(result.showId).toBe('show-1');
    expect(commands[0]?.traceparent).toBeNull();
  });

  it('refuses a rendition the domain rejects, with the domain code, before anything is written', async () => {
    // `rendition()` owns this rule and carries `media.size_invalid`. The schema
    // checked that `widthPx` is a NUMBER; that zero is not a width is the domain's
    // to say, and saying it twice is what critical-rules #2 forbids.
    const commands: PublishShowCommand[] = [];
    const controller = new CatalogController(recordingService(commands));

    await expect(
      controller.publish({
        ...body,
        media: { wide: [{ url: 'https://x/y.jpg', widthPx: 0, heightPx: 720 }], poster: [] },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === DomainErrorCode.MEDIA_SIZE_INVALID,
    );

    // The refusal is the point, but so is WHERE it happens: nothing reached the
    // transaction, so no show row and no outbox row were written.
    expect(commands).toHaveLength(0);
  });

  it('refuses an empty rendition url with the domain code', async () => {
    const commands: PublishShowCommand[] = [];
    const controller = new CatalogController(recordingService(commands));

    await expect(
      controller.publish({
        ...body,
        media: { wide: [{ url: '', widthPx: 640, heightPx: 360 }], poster: [] },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isDomainError(error) && error.code === DomainErrorCode.MEDIA_URL_EMPTY,
    );
    expect(commands).toHaveLength(0);
  });

  it('hands the service a MediaSet built by the domain, not the raw body object', async () => {
    // Before this, `body.media` was passed straight through as a `MediaSet` with
    // nothing having checked it — the type said `MediaSet` and no value had earned
    // the name.
    const commands: PublishShowCommand[] = [];
    await new CatalogController(recordingService(commands)).publish(body, TRACEPARENT);

    expect(commands[0]?.media).toEqual({
      wide: [{ url: 'https://cdn.example.test/w-640.jpg', widthPx: 640, heightPx: 360 }],
      poster: [{ url: 'https://cdn.example.test/p-480.jpg', widthPx: 480, heightPx: 720 }],
    });
  });

  it('hands the service the language dependency already narrowed to a member', async () => {
    const commands: PublishShowCommand[] = [];
    await new CatalogController(recordingService(commands)).publish(body);
    expect(commands[0]?.languageDependency).toBe(LanguageDependency.ESSENTIAL);
  });
});
