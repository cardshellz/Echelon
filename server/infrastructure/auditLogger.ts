/**
 * server/infrastructure/auditLogger.ts
 * Absolute compliance with Financial-Grade Rule 8: Logging & Auditability
 * Every critical action must log who, what, when, before/after state in structured JSON.
 */

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
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: "AUDIT",
      ...payload,
    };

    // Output strictly as JSON so it can be parsed by DataDog, CloudWatch, or Splunk.
    console.log(JSON.stringify(logEntry));
  }
}
