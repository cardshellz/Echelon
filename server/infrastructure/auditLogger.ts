/**
 * server/infrastructure/auditLogger.ts
 * Absolute compliance with Financial-Grade Rule 8: Logging & Auditability
 * Every critical action must log who, what, when, before/after state in structured JSON.
 */

import { db } from "../db";
import { logger } from "../platform/observability/logger";
import { persistAuditEvent, type AuditLogPayload } from "./transactional-audit";
export { persistAuditEvent, type AuditLogPayload, type PersistAuditEventOptions } from "./transactional-audit";

export class AuditLogger {
  static log(payload: AuditLogPayload): void {
    logger.info("audit.event_recorded", {
      actor: payload.actor,
      audit_action: payload.action,
      target: payload.target,
      before: payload.changes?.before,
      after: payload.changes?.after,
      context: payload.context,
    });
    // Preserve the legacy non-blocking DB persistence contract for existing callers.
    void persistAuditEvent(db, payload, { emitStructuredLog: false }).catch((err: unknown) => {
      logger.error("audit.persist_failed", {
        audit_action: payload.action,
        target: payload.target,
        error: err instanceof Error ? err : String(err),
      });
    });
  }
}
