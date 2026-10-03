import { camel, plural, spellings, type Spellings } from '#schematics/names';

export interface AggregateNames extends Spellings {
  readonly id: string;
  readonly idColumn: string;
  readonly row: string;
  readonly event: string;
  readonly snapshot: string;
  readonly repository: string;
  readonly typeOrmRepository: string;
  readonly recorder: string;
  /** Its repository's key in the app's transaction. */
  readonly collection: string;
}

/** Everything an aggregate's files are named after, which the command generator finds them by. */
export function aggregateNames(name: string, pluralName?: string): AggregateNames {
  const spelled = spellings(name);
  return {
    ...spelled,
    id: `${spelled.camel}Id`,
    idColumn: `${spelled.snake}_id`,
    row: `${spelled.pascal}Row`,
    event: `${spelled.pascal}Event`,
    snapshot: `${spelled.pascal}Snapshot`,
    repository: `${spelled.pascal}Repository`,
    typeOrmRepository: `TypeOrm${spelled.pascal}Repository`,
    recorder: `record${spelled.pascal}Events`,
    collection: camel(pluralName ?? plural(name)),
  };
}
