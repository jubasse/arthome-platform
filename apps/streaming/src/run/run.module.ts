import { Module } from '@nestjs/common';

import { SystemClock } from '@arthome/core';

import { DATE_FACTS_PROVIDER } from './date-facts.js';
import { IncidentsController } from './incidents.controller.js';
import { RunIngestAuthorizer } from './ingest-authorizer.js';
import { IngestHooksAttachment, RunIngestListener } from './ingest-listener.js';
import { RunConsoleReader } from './run-console.reader.js';
import { RunDeskController } from './run-desk.controller.js';
import {
  CheckRunHandler,
  MoveRunHandler,
  RaiseIncidentHandler,
  ResolveIncidentHandler,
} from './run-desk.handlers.js';
import { CLOCK } from '../clock.js';
import { MediaModule } from '../media/media.module.js';
import { StreamingTransactionsModule } from '../streaming-transactions.js';

/** The run desk in the API process, and the ingest hooks it attaches to the media plane at boot. */
@Module({
  imports: [StreamingTransactionsModule, MediaModule],
  controllers: [RunDeskController, IncidentsController],
  providers: [
    { provide: CLOCK, useValue: new SystemClock() },
    DATE_FACTS_PROVIDER,
    RunConsoleReader,
    MoveRunHandler,
    CheckRunHandler,
    RaiseIncidentHandler,
    ResolveIncidentHandler,
    RunIngestAuthorizer,
    RunIngestListener,
    IngestHooksAttachment,
  ],
})
export class RunModule {}
