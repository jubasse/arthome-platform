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
  /** W3C traceparent of the request that caused this, when there is one. */
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
   * Register an account and record the fact, in ONE transaction.
   *
   * ⚠ THE TRANSACTION IS THE FEATURE. Never `save()` then `emit()`: a crash
   *   between the two loses the event, and a rollback after the emission invents
   *   one. Both writes go through the SAME `manager` — the one the transaction
   *   hands us — and neither is retried on its own.
   *
   * ⚠ `traceparent` IS INJECTED HERE, NOT WHEN THE MESSAGE IS PUBLISHED. The
   *   relay runs outside this request: by the time Debezium reads the row, the
   *   context that caused it no longer exists anywhere. Injected later, the link
   *   between the command and everything it causes is lost for good
   *   (events.md §1.3).
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
          // The partition key. One account's events stay in order because of it.
          aggregateId: accountId,
          type: 'identity.account.registered.v1',
          // ⚠ Serialised HERE, by the producer. Debezium transports the bytes and
          //   reads none of them. The registry framing — magic byte, schema id,
          //   message indexes — belongs in front of these bytes and arrives with
          //   the schema registry; the path, key, headers and ordering do not
          //   depend on it.
          payload: toBinary(AccountRegisteredSchema, event),
          traceparent: command.traceparent,
          // No human actor: a registration is caused by the person being created,
          // who has no account id until this transaction commits.
          actorId: null,
        },
        occurredAt,
      );
    });

    return { accountId, messageId };
  }
}
