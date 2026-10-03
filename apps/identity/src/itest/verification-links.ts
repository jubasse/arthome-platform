import { EmailVerificationRequestedSchema } from '@arthome-platform/events';
import { fromBinary } from '@bufbuild/protobuf';
import type { DataSource } from 'typeorm';

/** What `notifications` would put in the link: the newest token the outbox carried to `email`. */
export async function newestLinkTokenTo(dataSource: DataSource, email: string): Promise<string> {
  const [row] = await dataSource.query<{ payload: Buffer }[]>(
    `SELECT o.payload FROM outbox_event o JOIN account a ON a.id::text = o.aggregateid
      WHERE a.email = $1 AND o.type = 'identity.account.email_verification_requested.v1'
      ORDER BY o.created_at DESC, o.id DESC LIMIT 1`,
    [email],
  );
  if (row === undefined) throw new Error(`no verification link was sent to ${email}`);
  return fromBinary(EmailVerificationRequestedSchema, new Uint8Array(row.payload)).token;
}
