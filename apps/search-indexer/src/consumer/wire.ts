import {
  LanguageDependency as WireLanguageDependency,
  PublicationState as WirePublicationState,
  ReplayPolicy as WireReplayPolicy,
  RightsScope as WireRightsScope,
  type ImageRendition,
  type LocalizedText,
} from '@arthome-platform/events';
import type { IndexedRendition } from '@arthome-platform/search-index';
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';

import {
  LanguageDependency,
  Locale,
  PublicationState,
  ReplayPolicy,
  RightsScope,
  type Bilingual,
} from '@arthome/core';

/**
 * The wire's numbers → the domain's members. `UNSPECIFIED`, and any member a newer producer
 * sends, reads as `null`: unknown is kept neutral, never guessed (critical-rules #10).
 */
const LANGUAGE_DEPENDENCY: Readonly<Partial<Record<WireLanguageDependency, LanguageDependency>>> = {
  [WireLanguageDependency.NONE]: LanguageDependency.NONE,
  [WireLanguageDependency.HELPFUL]: LanguageDependency.HELPFUL,
  [WireLanguageDependency.ESSENTIAL]: LanguageDependency.ESSENTIAL,
};

const REPLAY_POLICY: Readonly<Partial<Record<WireReplayPolicy, ReplayPolicy>>> = {
  [WireReplayPolicy.INCLUDED]: ReplayPolicy.INCLUDED,
  [WireReplayPolicy.SUBSCRIPTION]: ReplayPolicy.SUBSCRIPTION,
  [WireReplayPolicy.UNIT]: ReplayPolicy.UNIT,
  [WireReplayPolicy.NONE]: ReplayPolicy.NONE,
};

const PUBLICATION_STATE: Readonly<Partial<Record<WirePublicationState, PublicationState>>> = {
  [WirePublicationState.DRAFT]: PublicationState.DRAFT,
  [WirePublicationState.RESERVE]: PublicationState.RESERVE,
  [WirePublicationState.SCHEDULED]: PublicationState.SCHEDULED,
  [WirePublicationState.TECHNICAL]: PublicationState.TECHNICAL,
  [WirePublicationState.LIVE]: PublicationState.LIVE,
  [WirePublicationState.ENDED]: PublicationState.ENDED,
  [WirePublicationState.REPLAY_ONLINE]: PublicationState.REPLAY_ONLINE,
};

const RIGHTS_SCOPE: Readonly<Partial<Record<WireRightsScope, RightsScope>>> = {
  [WireRightsScope.WORLDWIDE]: RightsScope.WORLDWIDE,
  [WireRightsScope.RESTRICTED]: RightsScope.RESTRICTED,
};

export const languageDependencyOf = (wire: WireLanguageDependency): LanguageDependency | null =>
  LANGUAGE_DEPENDENCY[wire] ?? null;
export const replayPolicyOf = (wire: WireReplayPolicy): ReplayPolicy | null =>
  REPLAY_POLICY[wire] ?? null;
export const publicationStateOf = (wire: WirePublicationState): PublicationState | null =>
  PUBLICATION_STATE[wire] ?? null;
export const rightsScopeOf = (wire: WireRightsScope): RightsScope | null =>
  RIGHTS_SCOPE[wire] ?? null;

/** The product's two languages out of the wire's list; another language waits for its field. */
export function bilingualOf(texts: readonly LocalizedText[]): Bilingual {
  const textIn = (language: Locale): string =>
    texts.find((entry) => entry.contentLanguage === language)?.text ?? '';
  return { fr: textIn(Locale.FR), en: textIn(Locale.EN) };
}

export function indexedRendition(source: ImageRendition): IndexedRendition {
  return { url: source.url, width_px: source.widthPx, height_px: source.heightPx };
}

/**
 * Protobuf makes every field optional, so a fact with no timestamp decodes happily and would
 * be versioned at 0, losing to every later write for ever. The caller turns this into a
 * permanent failure.
 */
export function stated(timestamp: Timestamp | undefined, what: string): Date {
  if (timestamp === undefined) throw new Error(`${what} carries no occurred_at`);
  return timestampDate(timestamp);
}
