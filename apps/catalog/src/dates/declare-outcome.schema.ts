import { z } from 'zod';

import { DATE_OUTCOMES, DateOutcome } from '@arthome/core';
import { InstantIn, vocabularyIn } from '@arthome/core/schema';

/** The studio's `decideDateOutcome` (openapi/studio.yaml). */
export const DeclareOutcomeSchema = z
  .strictObject({
    outcome: vocabularyIn(DATE_OUTCOMES),
    message: z.strictObject({
      contentLanguage: z.string().min(1),
      text: z.string().min(1).max(600),
    }),
    rescheduledTo: InstantIn.nullable().default(null),
    expectedVersion: z.int().min(1),
  })
  // "Required, and only permitted, for `postponed`."
  .refine((body) => (body.outcome === DateOutcome.POSTPONED) === (body.rescheduledTo !== null), {
    path: ['rescheduledTo'],
  });

export type DeclareOutcomeBody = z.infer<typeof DeclareOutcomeSchema>;
