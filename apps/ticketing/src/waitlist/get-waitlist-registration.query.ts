import { Query } from '@nestjs/cqrs';

import type { WaitlistRegistrationView } from './waitlist-registration.js';

export class GetWaitlistRegistration extends Query<WaitlistRegistrationView> {
  public constructor(
    public readonly dateId: string,
    public readonly accountId: string,
  ) {
    super();
  }
}
