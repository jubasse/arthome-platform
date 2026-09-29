const WORD_BOUNDARY = /[-_\s]+|(?<=[a-z0-9])(?=[A-Z])/;

function wordsOf(name: string): string[] {
  return name
    .split(WORD_BOUNDARY)
    .filter((word) => word !== '')
    .map((word) => word.toLowerCase());
}

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

export const kebab = (name: string): string => wordsOf(name).join('-');

export const snake = (name: string): string => wordsOf(name).join('_');

export const constant = (name: string): string => snake(name).toUpperCase();

export const pascal = (name: string): string => wordsOf(name).map(capitalised).join('');

export function camel(name: string): string {
  const joined = pascal(name);
  return joined.charAt(0).toLowerCase() + joined.slice(1);
}

/** Naive on purpose: a name it gets wrong takes `--plural`. */
export function plural(name: string): string {
  if (name.endsWith('s')) return name;
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/** Every spelling a template needs of one name. */
export interface Spellings {
  readonly kebab: string;
  readonly snake: string;
  readonly constant: string;
  readonly pascal: string;
  readonly camel: string;
}

export function spellings(name: string): Spellings {
  return {
    kebab: kebab(name),
    snake: snake(name),
    constant: constant(name),
    pascal: pascal(name),
    camel: camel(name),
  };
}
