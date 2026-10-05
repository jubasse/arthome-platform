import { Injectable } from '@nestjs/common';

export interface PairedDevice {
  readonly deviceId: string;
}

export abstract class PairedDeviceVerifier {
  /** Null for a token that names no paired device: unknown, revoked, or forged. */
  public abstract verify(token: string): Promise<PairedDevice | null>;
}

/** Until pairing is built there is no paired device, so no token is one. */
@Injectable()
export class NoPairedDevices extends PairedDeviceVerifier {
  public verify(): Promise<PairedDevice | null> {
    return Promise.resolve(null);
  }
}
