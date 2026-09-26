import type { Types } from '@opensearch-project/opensearch';

export const LOWERCASE_NORMALIZER = 'arthome_lowercase';

/**
 * One shard for a relevance reason, not a size one: document frequency is counted per shard,
 *   so splitting makes identical documents score differently. Changing it needs a reindex.
 * Zero replicas is a development value, to raise before any real deployment: on the
 *   single-node stack a replica has nowhere to go and the cluster stays YELLOW for ever.
 * The normalizer is what makes a language filter work: BCP 47 is case-insensitive and
 *   `keyword` matches byte for byte, so `fr-FR` and `fr-fr` would be two terms.
 */
export const INDEX_SETTINGS: Types.Indices_Common.IndexSettings = {
  number_of_shards: 1,
  number_of_replicas: 0,
  analysis: {
    normalizer: {
      [LOWERCASE_NORMALIZER]: { type: 'custom', filter: ['lowercase'] },
    },
  },
};
