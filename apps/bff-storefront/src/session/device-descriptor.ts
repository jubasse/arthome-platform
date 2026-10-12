import { DeviceKind } from '@arthome/core';

import type { PresentedDevice } from '../identity/identity.client.js';

const LABEL_MAX_LENGTH = 80;
const UNKNOWN_LABEL = 'unknown';

/**
 * How the account's device list shows the browser: its `User-Agent`, and whether it says it is a
 *   phone. A display label only, it decides nothing: the session mode stays the surface's explicit
 *   choice (D-023). A same-origin proxy in front of the BFF forwards `user-agent` and
 *   `sec-ch-ua-mobile` for it.
 */
export function deviceDescriptorOf(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Omit<PresentedDevice, 'token'> {
  const agent = typeof headers['user-agent'] === 'string' ? headers['user-agent'].trim() : '';
  const mobile = headers['sec-ch-ua-mobile'] === '?1' || agent.includes('Mobi');
  return {
    kind: mobile ? DeviceKind.MOBILE : DeviceKind.DESKTOP,
    label: agent === '' ? UNKNOWN_LABEL : agent.slice(0, LABEL_MAX_LENGTH).trimEnd(),
  };
}
