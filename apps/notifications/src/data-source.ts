import { DataSource } from 'typeorm';

import { ProcessedMessage } from './consumer/processed-message.entity.js';
import { WelcomeEmail } from './consumer/welcome-email.entity.js';
import { env } from './env.js';
import { Initial1758700100000 } from './migrations/1758700100000-initial.js';

export const dataSource: DataSource = new DataSource({
  type: 'postgres',
  url: env.DATABASE_URL,
  entities: [ProcessedMessage, WelcomeEmail],
  migrations: [Initial1758700100000],
  synchronize: false,
  logging: false,
});
