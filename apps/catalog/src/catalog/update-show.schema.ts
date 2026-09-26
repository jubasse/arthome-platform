import { z } from 'zod';

import { LANGUAGE_DEPENDENCIES } from '@arthome/core';
import { SlugSchema, vocabularyIn } from '@arthome/core/schema';

import { BilingualIn, MediaSetIn } from './publish-show.schema.js';

/** What `ShowUpdated` carries, plus the copy; at least one field, or the call changes nothing. */
export const UpdateShowSchema = z
  .strictObject({
    genreIds: z.array(SlugSchema).optional(),
    tagIds: z.array(SlugSchema).optional(),
    languageDependency: vocabularyIn(LANGUAGE_DEPENDENCIES).optional(),
    media: MediaSetIn.optional(),
    title: BilingualIn.optional(),
    synopsis: BilingualIn.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0);

export type UpdateShowBody = z.infer<typeof UpdateShowSchema>;
