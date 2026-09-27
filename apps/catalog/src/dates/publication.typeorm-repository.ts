import type { EntityManager } from 'typeorm';

import { stateConflict } from './conflict.js';
import { Publication, type PublicationSnapshot } from './publication.aggregate.js';
import { PublicationRow } from './publication.entity.js';
import { PublicationRepository } from './publication.repository.js';

type SavedColumns = Omit<PublicationRow, 'date_id' | 'updated_at'>;

export class TypeOrmPublicationRepository extends PublicationRepository {
  private readonly loadedVersions = new WeakMap<Publication, number>();

  public constructor(
    private readonly manager: EntityManager,
    private readonly onSaved: (publication: Publication) => void,
  ) {
    super();
  }

  public async findByDateId(dateId: string): Promise<Publication | null> {
    const row = await this.manager.findOneBy(PublicationRow, { date_id: dateId });
    if (row === null) return null;
    const publication = Publication.restore(snapshotOf(row));
    this.loadedVersions.set(publication, row.version);
    return publication;
  }

  public async save(publication: Publication): Promise<void> {
    const { dateId, version } = publication.snapshot;
    const loadedVersion = this.loadedVersions.get(publication);
    if (loadedVersion === undefined) {
      throw new Error(`publication of ${dateId} was not loaded in this transaction`);
    }
    const { affected } = await this.manager.update(
      PublicationRow,
      { date_id: dateId, version: loadedVersion },
      columnsOf(publication.snapshot),
    );
    if (affected !== 1) {
      throw stateConflict(await this.manager.findOneByOrFail(PublicationRow, { date_id: dateId }));
    }
    this.loadedVersions.set(publication, version);
    this.onSaved(publication);
  }
}

function snapshotOf(row: PublicationRow): PublicationSnapshot {
  return {
    dateId: row.date_id,
    channelId: row.channel_id,
    state: row.state,
    version: row.version,
    publishedAt: row.published_at?.toISOString() ?? null,
    pricesLockedAt: row.prices_locked_at?.toISOString() ?? null,
    replayOnlineAt: row.replay_online_at?.toISOString() ?? null,
  };
}

const dateOf = (instant: string | null): Date | null =>
  instant === null ? null : new Date(instant);

function columnsOf(publication: PublicationSnapshot): SavedColumns {
  return {
    channel_id: publication.channelId,
    state: publication.state,
    version: publication.version,
    published_at: dateOf(publication.publishedAt),
    prices_locked_at: dateOf(publication.pricesLockedAt),
    replay_online_at: dateOf(publication.replayOnlineAt),
  };
}
