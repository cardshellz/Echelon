import {
  logger as platformLogger,
  type LogLevel,
} from "../../../platform/observability";
import type { DropshipLogEvent, DropshipLogger } from "./dropship-ports";

function emitDropshipPlatformEvent(
  action: string,
  level: Exclude<LogLevel, "debug">,
  outcome: string,
  event: DropshipLogEvent,
): void {
  platformLogger[level](action, {
    outcome,
    code: event.code,
    event_code: event.code,
    ...(level === "error" ? { error_code: event.code } : {}),
    message: event.message,
    context: event.context ?? {},
  });
}

/**
 * Canonical `DropshipLogger` backed by `server/platform/observability` (`P4.2`).
 * Attaches `AsyncLocalStorage` correlation IDs (`correlation_id`, `oms_order_id`,
 * `wms_order_id`, `shipment_id`, `channel_event_id`, `engine_ref`), ISO timestamps,
 * and automatic secret redaction to every Dropship log event.
 */
export function createDropshipPlatformLogger(action: string): DropshipLogger {
  return {
    debug: (event) =>
      platformLogger.debug(event.code, {
        action,
        code: event.code,
        event_code: event.code,
        message: event.message,
        context: event.context ?? {},
      }),
    info: (event) => emitDropshipPlatformEvent(action, "info", "ok", event),
    warn: (event) => emitDropshipPlatformEvent(action, "warn", "recovered", event),
    error: (event) => emitDropshipPlatformEvent(action, "error", "failed", event),
  };
}
