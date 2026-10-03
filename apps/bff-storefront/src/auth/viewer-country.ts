/** CLDR's unknown region: the country is re-evaluated at every read, so unknown is honest here. */
export const UNKNOWN_COUNTRY = 'ZZ';

const COUNTRY = /^[A-Z]{2}$/;

/**
 * The visitor's country as the infrastructure gateway's geolocation wrote it into `header`, the only
 *   source the BFF trusts: the surface is never asked (storefront.yaml `signUp`).
 */
export function viewerCountryOf(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  header: string | null,
): string {
  if (header === null) return UNKNOWN_COUNTRY;
  const value = headers[header];
  const country = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return COUNTRY.test(country) ? country : UNKNOWN_COUNTRY;
}
