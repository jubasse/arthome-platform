import { Module } from '@nestjs/common';

import { MediaServerController } from './media-server.controller.js';
import { RunModule } from '../run/run.module.js';

/** The route MediaMTX's origin asks before it accepts a feed; its identity is bound by `EDGE_PROVIDERS`. */
@Module({
  imports: [RunModule],
  controllers: [MediaServerController],
})
export class MediaServerModule {}
