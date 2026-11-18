/**
 * server/infrastructure/auditLogger.ts
 * Absolute compliance with Financial-Grade Rule 8: Logging & Auditability
 * Every critical action must log who, what, when, before/after state in structured JSON.
 */

import { db } from "../db";
import {persistAuditEvent,type AuditLogPayload} from "./transactional-audit";
export {persistAuditEvent,type AuditLogPayload,type PersistAuditEventOptions} from "./transactional-audit";

export class AuditLogger {
  static log(payload: AuditLogPayload): void {
    // Preserve the legacy non-blocking contract for existing callers.
    void persistAuditEvent(db, payload).catch((err) => {
      console.error(`[AuditLogger Error] Failed to persist audit event to postgres: ${err.message}`);
    });
  }
}
