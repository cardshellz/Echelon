/**
 * server/infrastructure/auditLogger.ts
 * Absolute compliance with Financial-Grade Rule 8: Logging & Auditability
 * Every critical action must log who, what, when, before/after state in structured JSON.
 */

import { db } from "../db";
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

/**
 * Persists an audit event through the table owner's API. Callers performing a
 * transactional command should pass that transaction so the state change and
 * its immutable audit record commit or roll back together.
 */
export async function persistAuditEvent(
  client: AuditEventWriteClient,
  payload: AuditLogPayload,
  options: PersistAuditEventOptions = {},
): Promise<void> {
  const timestamp = options.timestamp ?? new Date();

  if (options.emitStructuredLog !== false) {
    console.log(JSON.stringify({
      timestamp: timestamp.toISOString(),
      level: "AUDIT",
      ...payload,
    }));
  }

  await client.insert(auditEvents).values({
    timestamp,
    level: "AUDIT",
    actor: payload.actor,
    action: payload.action,
    target: payload.target,
    changes: payload.changes,
    context: payload.context,
  });
}

export class AuditLogger {
  static log(payload: AuditLogPayload): void {
    // Preserve the legacy non-blocking contract for existing callers.
    void persistAuditEvent(db, payload).catch((err) => {
      console.error(`[AuditLogger Error] Failed to persist audit event to postgres: ${err.message}`);
    });
  }
}
