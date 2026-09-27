import type { EntityManager } from 'typeorm';

/**
 * Orders a channel's face against the publication of the channel's dates, to the commit. A row
 *   lock cannot: before its creation the face has no row, so a face created while a date is
 *   published would reach neither the new public row nor the date its projection updates.
 */
export async function holdChannelFace(manager: EntityManager, channelId: string): Promise<void> {
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`artist:${channelId}`]);
}
