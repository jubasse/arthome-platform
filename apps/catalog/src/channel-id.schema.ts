import { z } from 'zod';

/** Text like the show's `channel_id`: the fixtures in use are not UUIDs. */
export const ChannelIdParam: z.ZodString = z.string().min(1);
