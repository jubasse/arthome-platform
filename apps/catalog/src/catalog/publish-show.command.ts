import { Command } from '@nestjs/cqrs';

import type { Bilingual, LanguageDependency, MediaSet } from '@arthome/core';

export interface ShowToPublish {
  readonly channelId: string;
  readonly artistId: string;
  readonly categoryId: string;
  readonly genreIds: readonly string[];
  readonly tagIds: readonly string[];
  readonly runtimeMin: number;
  readonly languageDependency: LanguageDependency;
  readonly spokenLanguages: readonly string[];
  readonly subtitleLanguages: readonly string[];
  readonly surtitleLanguages: readonly string[];
  readonly media: MediaSet;
  readonly title: Bilingual;
  readonly synopsis: Bilingual;
}

export interface PublishedShow {
  readonly showId: string;
  readonly messageId: string;
}

/** `POST /shows`: the show and its `ShowPublished`, slugged from its title (D-075). */
export class PublishShow extends Command<PublishedShow> {
  public constructor(
    public readonly show: ShowToPublish,
    public readonly traceparent: string | null,
  ) {
    super();
  }
}
