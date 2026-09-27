/**
 * Deeply, so that a nested array written in place throws as well: an aggregate replaces its
 *   snapshot, never edits it.
 */
export function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) frozen(inner);
  }
  return value;
}
