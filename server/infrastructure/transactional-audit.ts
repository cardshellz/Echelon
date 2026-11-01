import type { db } from "../db";
import { auditEvents } from "@shared/schema";

type AuditEventWriteClient = Pick<typeof db, "insert">;
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
