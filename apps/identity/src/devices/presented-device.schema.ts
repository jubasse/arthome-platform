import { z } from 'zod';

import { DEVICE_KINDS, DeviceKind } from '@arthome/core';

/** The device the BFF signs a viewer in from: its token, when the browser holds one. */
export const PresentedDeviceSchema = z.strictObject({
  token: z.string().min(1).max(512).nullable(),
  kind: z.enum(DEVICE_KINDS),
  label: z.string().min(1).max(80),
});

export type PresentedDevice = z.infer<typeof PresentedDeviceSchema>;

/** What a call without `device` stands for: the BFF before it sends one (PB1). */
export const UNDESCRIBED_DEVICE: PresentedDevice = {
  token: null,
  kind: DeviceKind.DESKTOP,
  label: 'unknown',
};
