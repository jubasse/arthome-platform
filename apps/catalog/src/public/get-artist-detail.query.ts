import type { PerishableResponse } from '@arthome-platform/http-edge';
import { Query } from '@nestjs/cqrs';

import type { ArtistDetail } from './artist-page.js';

/** The storefront's `getArtistDetail`, `GET /v1/artists/:artistId`. */
export class GetArtistDetail extends Query<PerishableResponse<ArtistDetail>> {
  public constructor(public readonly artistId: string) {
    super();
  }
}
