import type { PerishableResponse } from '@arthome-platform/http-edge';
import { Query } from '@nestjs/cqrs';

import type { ArtistSummary } from './artist-page.js';
import type { DateCard } from './date-card.js';
import type { LinkKind, ResolveQuery } from './resolve-query.schema.js';

/** The current form, which differs from the link followed when that link held a replaced slug. */
export type ResolvedLink =
  | { readonly kind: typeof LinkKind.SHOW; readonly id: string; readonly canonicalUrl: string }
  | {
      readonly kind: typeof LinkKind.DATE;
      readonly id: string;
      readonly canonicalUrl: string;
      readonly date: DateCard;
    }
  | {
      readonly kind: typeof LinkKind.ARTIST;
      readonly id: string;
      readonly canonicalUrl: string;
      readonly artist: ArtistSummary;
    };

/** The storefront's `resolvePublicLink`, `GET /v1/resolve`. */
export class ResolvePublicLink extends Query<PerishableResponse<ResolvedLink>> {
  public constructor(public readonly params: ResolveQuery) {
    super();
  }
}
