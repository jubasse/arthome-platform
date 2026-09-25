import { readConsumerEnv, type ConsumerEnv } from '@arthome-platform/config';

import { Service } from '@arthome/core';

/**
 * ⚠ PARSED HERE, AT MODULE LOAD, AND NOT IN THE BOOTSTRAP. The migration CLI loads
 *   `data-source.ts` with no `main()` to run, so a parse inside one would leave the
 *   CLI reading an unvalidated environment — which is how every service ended up
 *   reaching for `process.env` directly.
 *
 *   The database is named after the service, so the name is the domain constant and not
 *   a copy of it — `check-enums` is right to refuse the literal. It is used only to
 *   build the local default; `infra/postgres/init-databases.sql` creates the database.
 */
export const env: ConsumerEnv = readConsumerEnv(Service.NOTIFICATIONS);
