/** The `default` of an exhaustive `switch`: a member left without its case fails to compile here. */
export function assertNever(value: never): never {
  throw new Error(`unhandled ${JSON.stringify(value)}`);
}
