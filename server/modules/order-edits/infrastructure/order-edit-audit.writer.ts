import type { PoolClient } from "pg";
import { z } from "zod";
import { orderEditAuditActor } from "../domain/order-edit-actor";

const auditSchema = z
  .object({
    operationId: z.string().uuid().nullable(),
    connectionId: z.number().int().positive().safe(),
    actorId: z.string().min(1).nullable(),
    action: z.string().min(1),
    before: z.unknown().refine((value) => value !== undefined),
    after: z.unknown().refine((value) => value !== undefined),
    occurredAt: z.coerce.date(),
  })
  .strict();

export interface OrderEditAuditInput {
  operationId: string | null;
  connectionId: number;
  actorId: string | null;
  action: string;
  before: unknown;
  after: unknown;
  occurredAt: Date | string;
}

/** Append immutable order-edit evidence in the caller's financial transaction. */
export async function appendOrderEditAudit(
  tx: Pick<PoolClient, "query">,
  input: OrderEditAuditInput,
): Promise<void> {
  const value = auditSchema.parse(input);
  const actor = orderEditAuditActor(value.actorId);
  if (actor.customerChannelId !== null) {
    await tx.query(
      `INSERT INTO oms.order_edit_events(operation_id,connection_id,actor_id,action,before_state,after_state,occurred_at,customer_actor_channel_id,customer_actor_external_id)
      VALUES($1,$2,NULL,$3,$4,$5,$6,$7,$8)`,
      [value.operationId, value.connectionId, value.action,
        JSON.stringify(value.before), JSON.stringify(value.after), value.occurredAt,
        actor.customerChannelId, actor.externalCustomerId],
    );
    return;
  }
  await tx.query(
    `INSERT INTO oms.order_edit_events(operation_id,connection_id,actor_id,action,before_state,after_state,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      value.operationId,
      value.connectionId,
      value.actorId,
      value.action,
      JSON.stringify(value.before),
      JSON.stringify(value.after),
      value.occurredAt,
    ],
  );
}
