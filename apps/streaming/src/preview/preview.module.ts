import { Module } from '@nestjs/common';

import { PostgresPreviewMeter } from './postgres-preview-meter.js';
import { PREVIEW_METER } from '../playback/preview-meter.js';

/** Binds the playback's `PreviewMeter` port to the Postgres budget. */
@Module({
  providers: [{ provide: PREVIEW_METER, useClass: PostgresPreviewMeter }],
  exports: [PREVIEW_METER],
})
export class PreviewModule {}
