import { z } from 'zod';

import { PUBLICATION_PROMISES, PublicationState } from '@arthome/core';
import { vocabularyIn } from '@arthome/core/schema';

/**
 * A narrowing of `PUBLICATION_STATES`, as the contract's: `live` and `ended` are caused by a
 * `streaming` event, never commanded, or a studio could declare on air a date sending nothing.
 */
const COMMANDED_STATES = [
  PublicationState.DRAFT,
  PublicationState.RESERVE,
  PublicationState.SCHEDULED,
  PublicationState.TECHNICAL,
  PublicationState.REPLAY_ONLINE,
] as const;

/** The studio's `moveDatePublicationState` (openapi/studio.yaml). */
export const TransitionPublicationSchema = z.strictObject({
  to: vocabularyIn(COMMANDED_STATES),
  expectedVersion: z.int().min(1),
  acknowledgedPromiseCode: vocabularyIn(PUBLICATION_PROMISES).nullable().default(null),
});

export type TransitionPublicationBody = z.infer<typeof TransitionPublicationSchema>;
