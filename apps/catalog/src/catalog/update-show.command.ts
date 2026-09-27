import { Command } from '@nestjs/cqrs';

import type { Bilingual, LanguageDependency, MediaSet } from '@arthome/core';

/** An absent field keeps its value. */
export interface ShowChanges {
  readonly genreIds?: readonly string[];
  readonly tagIds?: readonly string[];
  readonly languageDependency?: LanguageDependency;
  readonly media?: MediaSet;
  readonly title?: Bilingual;
  readonly synopsis?: Bilingual;
}

/** `PATCH /shows/:showId`. */
export class UpdateShow extends Command<{ showId: string }> {
  public constructor(
    public readonly showId: string,
    public readonly changes: ShowChanges,
    public readonly traceparent: string | null,
  ) {
    super();
  }
}
