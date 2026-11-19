import type { db } from "../db";
import { auditEvents } from "@shared/schema";
import { sql } from "drizzle-orm";

type AuditEventWriteClient = Pick<typeof db, "insert">;
export type AuditEventInsertRow = typeof auditEvents.$inferInsert;
export interface AuditLogPayload {
  actor: string;
  action: string;
  target?: string;
  changes?: {
    before: Record<string, any> | null;
    after: Record<string, any> | null;
  };
  context?: Record<string, any>;
}
export interface PersistAuditEventOptions {
  timestamp?: Date;
  emitStructuredLog?: boolean;
}

/** One audit persistence implementation, with the caller's transaction. Importing
 * this owner never creates an application pool or reads a hidden DB connection. */
export async function persistAuditEvent(
  client: AuditEventWriteClient,
  payload: AuditLogPayload,
  options: PersistAuditEventOptions = {},
): Promise<void> {
  const timestamp = options.timestamp ?? new Date();
  if (options.emitStructuredLog !== false)
    console.log(
      JSON.stringify({
        timestamp: timestamp.toISOString(),
        level: "AUDIT",
        ...payload,
      }),
    );
  await client
    .insert(auditEvents)
    .values({
      timestamp,
      level: "AUDIT",
      actor: payload.actor,
      action: payload.action,
      target: payload.target,
      changes: payload.changes,
      context: payload.context,
    });
}

export async function insertAuditEventDrizzle(
  client: AuditEventWriteClient,
  values: AuditEventInsertRow | AuditEventInsertRow[] | Record<string, unknown>[],
): Promise<void> {
  await client.insert(auditEvents).values(values as any);
}

export async function insertAuditEventDrizzleReturningId(
  client: AuditEventWriteClient,
  values: AuditEventInsertRow,
): Promise<Array<{ id: number }>> {
  return client
    .insert(auditEvents)
    .values(values)
    .returning({ id: auditEvents.id });
}

export async function insertAuditEventSql(
  executor: { execute: (...args: any[]) => any },
  input: {
    timestamp: Date;
    actor: string | null | undefined;
    action: string;
    target: string | null | undefined;
    changesJson: string;
    contextJson: string;
    returningId?: boolean;
  },
): Promise<{ rows: Array<Record<string, any>> }> {
  if (input.returningId) {
    return executor.execute(sql`
      INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
      VALUES(${input.timestamp},'AUDIT',${input.actor},${input.action},${input.target},${input.changesJson}::jsonb,${input.contextJson}::jsonb)
      RETURNING id
    `);
  }
  return executor.execute(sql`
    INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES(${input.timestamp},'AUDIT',${input.actor},${input.action},${input.target},${input.changesJson}::jsonb,${input.contextJson}::jsonb)
  `);
}

export async function insertAuditEventPgQuery<TRow = Record<string, unknown>>(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: TRow[]; rowCount: number | null }> },
  input: {
    timestamp: Date;
    actor: unknown;
    action: string;
    target: string | null;
    changesJson: string | null;
    contextJson: string | null;
    inlineAction?: boolean;
    valuesIndent?: string;
  },
): Promise<{ rows: TRow[]; rowCount: number | null }> {
  if (input.inlineAction) {
    if (!/^[a-z0-9._:-]+$/i.test(input.action)) {
      throw new Error(`Invalid inline audit action token: ${input.action}`);
    }
    const indent = input.valuesIndent ?? "      ";
    return client.query(
      `INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)\n${indent}VALUES($1,'AUDIT',$2,'${input.action}',$3,$4::jsonb,$5::jsonb)`,
      [input.timestamp, input.actor, input.target, input.changesJson, input.contextJson],
    );
  }
  return client.query(
    `INSERT INTO public.audit_events(
       timestamp, level, actor, action, target, changes, context
     ) VALUES ($1,'AUDIT',$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [input.timestamp, input.actor, input.action, input.target, input.changesJson, input.contextJson],
  );
}

export async function insertAuditEventDefaultTimestampPgQuery(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  input: {
    actor: string;
    action: string;
    target: string;
    changesJson: string;
    contextJson: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO public.audit_events (
       level, actor, action, target, changes, context
     ) VALUES (
       'AUDIT', $1, $2, $3, $4::jsonb, $5::jsonb
     )`,
    [input.actor, input.action, input.target, input.changesJson, input.contextJson],
  );
}

export async function insertProduct102IdentityCleanupAuditPgQuery(
  client: { query: <T = any>(text: string, values?: unknown[]) => Promise<{ rows: T[] }> },
  input: {
    occurredAt: Date | string;
    actorId: string;
    expectedHash: string;
    requestHash: string;
    commandKey: string;
  },
): Promise<{ rows: Array<{ id: string }> }> {
  return client.query<{ id: string }>(
    `INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
    VALUES($1,'AUDIT',$2,'catalog.product_identity_removed','product:102',
      jsonb_build_object('sourceProductId',102,'targetProductId',5,'stateHash',$3::text),
      jsonb_build_object('requestHash',$4::text,'commandKey',$5::text)) RETURNING id::text`,
    [
      input.occurredAt,
      input.actorId,
      input.expectedHash,
      input.requestHash,
      input.commandKey,
    ],
  );
}
