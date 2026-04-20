/**
 * server/infrastructure/auditLogger.ts
 * Absolute compliance with Financial-Grade Rule 8: Logging & Auditability
 * Every critical action must log who, what, when, before/after state in structured JSON.
 */

import { db } from "../db";
import { auditEvents } from "@shared/schema";

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

export class AuditLogger {
  static log(payload: AuditLogPayload): void {
    const timestamp = new Date();
    
    // 1. Output strictly as JSON so it can be parsed by DataDog, CloudWatch, or Splunk.
    const logEntry = {
      timestamp: timestamp.toISOString(),
      level: "AUDIT",
      ...payload,
    };
    console.log(JSON.stringify(logEntry));

    // 2. Persist to audit_events (fire-and-forget to avoid blocking callers and crashing on fail)
    db.insert(auditEvents).values({
      timestamp,
      level: "AUDIT",
      actor: payload.actor,
      action: payload.action,
      target: payload.target,
      changes: payload.changes,
      context: payload.context,
    }).catch((err) => {
      console.error(`[AuditLogger Error] Failed to persist audit event to postgres: ${err.message}`);
    });
  }
}
