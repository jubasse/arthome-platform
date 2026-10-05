import { Command } from '@nestjs/cqrs';

/** One pass of the availability publisher; answers how many dates it published. */
export class PublishDueAvailability extends Command<number> {}
