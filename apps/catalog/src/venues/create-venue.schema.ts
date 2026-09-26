import { z } from 'zod';

import { CountryCodeSchema, IanaTimeZoneSchema } from '@arthome/core/schema';

export const CreateVenueSchema = z.strictObject({
  name: z.string().min(1),
  city: z.string().min(1),
  country: CountryCodeSchema,
  timeZone: IanaTimeZoneSchema,
});

export type CreateVenueBody = z.infer<typeof CreateVenueSchema>;
