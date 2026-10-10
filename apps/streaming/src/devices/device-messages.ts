import { DeviceRevokedSchema, DeviceSessionClosedSchema } from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import { timestampDate, type Timestamp } from '@bufbuild/protobuf/wkt';

import { RevokeDeviceLeases } from './revoke-device-leases.command.js';
import { RevokeProfileLeases } from './revoke-profile-leases.command.js';
import type { Reader } from '../consumed-messages.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id that is not a UUID would revoke nothing, silently: it does not read, and is seen in the DLQ. */
function idOf(value: string, field: string): string {
  if (!UUID.test(value)) throw new Error(`${field} is not a UUID: ${JSON.stringify(value)}`);
  return value;
}

function instantOf(timestamp: Timestamp | undefined): Date {
  if (timestamp === undefined) throw new Error('no occurred_at');
  return timestampDate(timestamp);
}

/** Identity's device events on `arthome.identity.device`, key `device_id`. */
export const DEVICE_READERS: Readonly<Record<string, Reader>> = {
  'identity.device.revoked.v1': (value, delivery) => {
    const event = fromBinary(DeviceRevokedSchema, value);
    return new RevokeDeviceLeases(delivery, {
      accountId: idOf(event.accountId, 'account_id'),
      deviceId: idOf(event.deviceId, 'device_id'),
      occurredAt: instantOf(event.occurredAt),
    });
  },
  'identity.device_session.closed.v1': (value, delivery) => {
    const event = fromBinary(DeviceSessionClosedSchema, value);
    return new RevokeProfileLeases(delivery, {
      accountId: idOf(event.accountId, 'account_id'),
      deviceId: idOf(event.deviceId, 'device_id'),
      profileId: idOf(event.profileId, 'profile_id'),
      occurredAt: instantOf(event.occurredAt),
    });
  },
};
