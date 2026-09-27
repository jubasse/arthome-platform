import { ArtistUpdatedSchema } from '@arthome-platform/events';
import {
  RefusalException,
  schemaInvalidException,
  type MemorisedResponse,
} from '@arthome-platform/http-edge';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { HttpStatus, Inject } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import type { EntityManager } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { CatalogErrorCode, FailureNature, type Clock, type Instant } from '@arthome/core';

import { Artist } from './artist.entity.js';
import { holdChannelFace } from './channel-face-lock.js';
import { UpdateChannelIdentity, type ChannelIdentity } from './update-channel-identity.command.js';
import { writeCatalogEvent } from '../catalog-events.js';
import { CatalogTransactions } from '../catalog-transactions.js';
import { CLOCK } from '../clock.js';
import { slugify } from '../dates/slug.js';
import { runIdempotentlyVersioned } from '../idempotency/idempotency.js';
import { projectArtist } from '../public/date-detail-projection.js';
import { LinkKind } from '../public/resolve-query.schema.js';
import { UNSCOPED, reservedForAnother, retireSlug, type SlugKey } from '../public/slug-aliases.js';
import { stateConflict } from '../refusals.js';

function slugTaken(): RefusalException {
  return new RefusalException(HttpStatus.CONFLICT, {
    code: CatalogErrorCode.ARTIST_SLUG_TAKEN,
    params: {},
    nature: FailureNature.REFUSED,
  });
}

@CommandHandler(UpdateChannelIdentity)
export class UpdateChannelIdentityHandler implements ICommandHandler<UpdateChannelIdentity> {
  public constructor(
    private readonly transactions: CatalogTransactions,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public execute(command: UpdateChannelIdentity): Promise<MemorisedResponse<ChannelIdentity>> {
    return this.transactions.run(({ manager }) =>
      runIdempotentlyVersioned(manager, command.idempotency, this.clock, () =>
        this.updateIn(manager, command),
      ),
    );
  }

  private async updateIn(
    manager: EntityManager,
    { channelId, body, traceparent }: UpdateChannelIdentity,
  ): Promise<{ readonly data: ChannelIdentity; readonly version: number }> {
    await holdChannelFace(manager, channelId);
    const current = await manager.findOne(Artist, {
      where: { channel_id: channelId },
      lock: { mode: 'pessimistic_write' },
    });
    const version = current?.version ?? 0;
    if (body.expectedVersion !== version) throw stateConflict({ version });

    const id = current?.id ?? uuidv7();
    const publicName = body.publicName ?? current?.public_name;
    const categoryId = body.categoryId ?? current?.category_id;
    if (publicName === undefined || categoryId === undefined) {
      throw schemaInvalidException([
        ...(publicName === undefined ? [{ path: ['publicName'] }] : []),
        ...(categoryId === undefined ? [{ path: ['categoryId'] }] : []),
      ]);
    }
    const now = this.clock.now();
    const slug = body.slug ?? current?.slug ?? (await freeArtistSlug(manager, publicName, id, now));
    if (body.slug !== undefined && (await slugHeldByAnother(manager, body.slug, id, now))) {
      throw slugTaken();
    }
    if (current !== null && current.slug !== slug) {
      await retireSlug(manager, artistSlugKey(current.slug), id, now);
    }

    const artist = manager.create(Artist, {
      id,
      channel_id: channelId,
      public_name: publicName,
      slug,
      biography: body.biography ?? current?.biography ?? [],
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
        traceparent,
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
