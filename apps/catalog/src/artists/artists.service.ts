import { ArtistUpdatedSchema } from '@arthome-platform/events';
import {
  RefusalException,
  schemaInvalidException,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import {
  CatalogErrorCode,
  DomainErrorCode,
  FailureNature,
  type Clock,
  type Instant,
} from '@arthome/core';

import { Artist, type LocalizedCopy } from './artist.entity.js';
import type { UpdateIdentityBody } from './update-identity.schema.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { CLOCK } from '../clock.js';
import { slugify } from '../dates/slug.js';
import { runIdempotentlyVersioned, type IdempotentRequest } from '../idempotency/idempotency.js';
import { projectArtist } from '../public/date-detail-projection.js';
import { LinkKind } from '../public/resolve-query.schema.js';
import { UNSCOPED, reservedForAnother, retireSlug, type SlugKey } from '../public/slug-aliases.js';

export interface UpdateIdentityCommand extends UpdateIdentityBody {
  readonly channelId: string;
  readonly traceparent: string | null;
}

export interface ChannelIdentity {
  readonly artistId: string;
  readonly publicName: string;
  readonly slug: string;
  readonly categoryId: string;
  readonly biography: readonly LocalizedCopy[];
}

function conflict(version: number): RefusalException {
  return new RefusalException(HttpStatus.CONFLICT, {
    code: DomainErrorCode.STATE_CONFLICT,
    params: { version },
    nature: FailureNature.REFUSED,
  });
}

function slugTaken(): RefusalException {
  return new RefusalException(HttpStatus.CONFLICT, {
    code: CatalogErrorCode.ARTIST_SLUG_TAKEN,
    params: {},
    nature: FailureNature.REFUSED,
  });
}

@Injectable()
export class ArtistsService {
  public constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The channel's public face. `expectedVersion: 0` creates it, and only on a channel that has
   *   none; every later edit names the version it read.
   */
  public updateIdentity(
    command: UpdateIdentityCommand,
    idempotency: IdempotentRequest,
  ): Promise<MemorisedResponse<ChannelIdentity>> {
    return this.dataSource.transaction((manager) =>
      runIdempotentlyVersioned(manager, idempotency, this.clock, () =>
        this.updateIn(manager, command),
      ),
    );
  }

  private async updateIn(
    manager: EntityManager,
    command: UpdateIdentityCommand,
  ): Promise<{ readonly data: ChannelIdentity; readonly version: number }> {
    const current = await manager.findOne(Artist, {
      where: { channel_id: command.channelId },
      lock: { mode: 'pessimistic_write' },
    });
    const version = current?.version ?? 0;
    if (command.expectedVersion !== version) throw conflict(version);

    const id = current?.id ?? uuidv7();
    const publicName = command.publicName ?? current?.public_name;
    const categoryId = command.categoryId ?? current?.category_id;
    if (publicName === undefined || categoryId === undefined) {
      throw schemaInvalidException([
        ...(publicName === undefined ? [{ path: ['publicName'] }] : []),
        ...(categoryId === undefined ? [{ path: ['categoryId'] }] : []),
      ]);
    }
    const now = this.clock.now();
    const slug =
      command.slug ?? current?.slug ?? (await freeArtistSlug(manager, publicName, id, now));
    if (command.slug !== undefined && (await slugHeldByAnother(manager, command.slug, id, now))) {
      throw slugTaken();
    }
    if (current !== null && current.slug !== slug) {
      await retireSlug(manager, artistSlugKey(current.slug), id, now);
    }

    const artist = manager.create(Artist, {
      id,
      channel_id: command.channelId,
      public_name: publicName,
      slug,
      biography: command.biography ?? current?.biography ?? [],
      category_id: categoryId,
      version: version + 1,
    });
    await manager.save(Artist, artist);
    await projectArtist(manager, artist);

    const occurredAt = new Date(now);
    await writeCatalogEvent(
      manager,
      {
        type: 'catalog.artist.updated.v1',
        key: artist.id,
        payload: toBinary(
          ArtistUpdatedSchema,
          create(ArtistUpdatedSchema, {
            artistId: artist.id,
            channelId: artist.channel_id,
            categoryId: artist.category_id,
            publicName: artist.public_name,
            slug: artist.slug,
            biography: artist.biography.map((copy) => ({ ...copy })),
            occurredAt: timestampFromDate(occurredAt),
          }),
        ),
        traceparent: command.traceparent,
      },
      occurredAt,
    );

    return {
      data: {
        artistId: artist.id,
        publicName: artist.public_name,
        slug: artist.slug,
        categoryId: artist.category_id,
        biography: artist.biography,
      },
      version: artist.version,
    };
  }
}

function artistSlugKey(slug: string): SlugKey {
  return { kind: LinkKind.ARTIST, scope: UNSCOPED, slug };
}

/** Held by another artist, or still pointing at one that left it less than a month ago (D-075). */
async function slugHeldByAnother(
  manager: EntityManager,
  slug: string,
  id: string,
  now: Instant,
): Promise<boolean> {
  const holder = await manager.findOneBy(Artist, { slug });
  if (holder !== null) return holder.id !== id;
  return reservedForAnother(manager, artistSlugKey(slug), id, now);
}

/** The name's slug when free, then one carrying the artist's own id; the index settles a race. */
async function freeArtistSlug(
  manager: EntityManager,
  publicName: string,
  id: string,
  now: Instant,
): Promise<string> {
  const base = slugify(publicName);
  // A name too short for the contract's three characters leaves the id's tail alone.
  if (base.length < 3) return id.slice(-12);
  if (!(await slugHeldByAnother(manager, base, id, now))) return base;
  return `${base}-${id.slice(-8)}`;
}
