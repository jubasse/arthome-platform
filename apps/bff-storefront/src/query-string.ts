type QueryValue = string | number | boolean;

function isQueryValue(value: unknown): value is QueryValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** A validated query back into a query string for the service behind, lists as repeated keys. */
export function searchParamsOf(query: Readonly<Record<string, unknown>>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    const items: readonly unknown[] = Array.isArray(value) ? value : [value];
    for (const item of items) if (isQueryValue(item)) params.append(key, String(item));
  }
  return params;
}
