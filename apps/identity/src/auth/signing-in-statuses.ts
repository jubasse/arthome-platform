import { AccountStatus } from '@arthome/core';

/** The statuses whose credential still opens a session: a deletion request is undone by signing in. */
export const SIGNING_IN_STATUSES: readonly AccountStatus[] = [
  AccountStatus.ACTIVE,
  AccountStatus.DELETION_REQUESTED,
];
