import type { Publication } from './publication.aggregate.js';

export abstract class PublicationRepository {
  public abstract findByDateId(dateId: string): Promise<Publication | null>;

  /**
   * Conditioned on the version it was loaded at: a change committed since is refused, 409. One
   *   it did not load is a draft's, inserted.
   */
  public abstract save(publication: Publication): Promise<void>;
}
