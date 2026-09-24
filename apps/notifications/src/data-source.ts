import { DataSource } from 'typeorm';

import { ProcessedMessage } from './consumer/processed-message.entity.js';
import { WelcomeEmail } from './consumer/welcome-email.entity.js';
import { Initial1758700100000 } from './migrations/1758700100000-initial.js';

export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL ?? 'postgres://arthome:arthome@localhost:55432/notifications',
  entities: [ProcessedMessage, WelcomeEmail],
  migrations: [Initial1758700100000],
  synchronize: false,
  logging: false,
});
