/** Where a consumed message came from: its command claims its id and carries its trace on. */
export interface Delivery {
  readonly messageId: string;
  readonly topic: string;
  readonly traceparent: string | null;
}
