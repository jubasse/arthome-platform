import { rendition, type MediaSet, type Rendition } from '@arthome/core';

import type { MediaIn } from './publish-show.schema.js';

/**
 * It throws a `DomainError`, not an `HttpException`: `ErrorEnvelopeFilter` maps it with no
 *   translation table, because a `DomainError` already carries `code`, `params` and `nature`.
 *   It stops at the first bad rendition — collecting would mean reimplementing its checks.
 */
export function mediaSetOf(media: MediaIn): MediaSet {
  const toRendition = (declared: { url: string; widthPx: number; heightPx: number }): Rendition =>
    rendition(declared.url, declared.widthPx, declared.heightPx);

  return {
    wide: media.wide.map(toRendition),
    poster: media.poster.map(toRendition),
  };
}
