/** How long a call to catalog is waited for, by what the surface asked. */
export interface CatalogBudgets {
  readonly searchMs: number;
  readonly publicReadMs: number;
}

export const CATALOG_BUDGETS: unique symbol = Symbol('CatalogBudgets');

/**
 * transport.md §5.9: the search's 200 ms because a television types one key at a time, the
 *   composed public read's 400 ms for the date page and the resolution.
 */
export const TRANSPORT_BUDGETS: CatalogBudgets = { searchMs: 200, publicReadMs: 400 };
