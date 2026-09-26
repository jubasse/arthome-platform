import { AccountRegisteredSchema } from '@arthome-platform/events';
import { writeOutboxEvent } from '@arthome-platform/messaging';
import { create, toBinary } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { Account } from './account.entity.js';

export interface RegisterAccountCommand {
  readonly publicHandle: string;
  readonly email: string;
  readonly locale: string;
  readonly country: string;
  readonly traceparent: string | null;
}

export interface RegisteredAccount {
  readonly accountId: string;
  readonly messageId: string;
}

@Injectable()
export class RegisterAccountService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * ONE transaction, and that is the feature: `save()` then `emit()` loses the event on
   *   a crash between them and invents one on a rollback after.
   *
   * `traceparent` is injected here, not at publication: the relay runs outside this
   *   request, and by then the context that caused the row is gone (events.md §1.3).
   */
  async register(command: RegisterAccountCommand): Promise<RegisteredAccount> {
    const accountId = uuidv7();
    const occurredAt = new Date();

    const event = create(AccountRegisteredSchema, {
      accountId,
      occurredAt: timestampFromDate(occurredAt),
      locale: command.locale,
      country: command.country,
    });

    let messageId = '';
    await this.dataSource.transaction(async (manager) => {
      await manager.insert(Account, {
        id: accountId,
        public_handle: command.publicHandle,
        email: command.email,
        locale: command.locale,
        country: command.country,
      });

      messageId = await writeOutboxEvent(
        manager,
        {
          // `identity.account` → topic `arthome.identity.account` (events.md §3).
          aggregateType: 'identity.account',
          aggregateId: accountId,
          type: 'identity.account.registered.v1',
          payload: toBinary(AccountRegisteredSchema, event),
          traceparent: command.traceparent,
          // No human actor: the person being created has no account id until this commits.
          actorId: null,
        },
        occurredAt,
      );
    });

    return { accountId, messageId };
  }
}
