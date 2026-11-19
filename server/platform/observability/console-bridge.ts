import { logger, type LogLevel } from "./logger";

type ConsoleMethodName = "debug" | "log" | "info" | "warn" | "error";

interface OriginalConsoleMethods {
  debug: typeof console.debug;
  log: typeof console.log;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
}

let installedOriginals: OriginalConsoleMethods | null = null;
let inBridge = false;

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON — fall through to message formatting.
  }
  return null;
}

function normalizeConsoleArgs(
  method: ConsoleMethodName,
  args: unknown[],
): { action: string; data: Record<string, unknown> } {
  const defaultAction = `console.${method}`;
  if (args.length === 0) {
    return { action: defaultAction, data: {} };
  }

  // Single JSON string (e.g. legacy JSON.stringify logs): avoid double-encoding.
  if (args.length === 1 && typeof args[0] === "string") {
    const parsed = tryParseJsonObject(args[0]);
    if (parsed) {
      const action =
        typeof parsed.action === "string" && parsed.action.trim()
          ? parsed.action.trim()
          : typeof parsed.event === "string" && parsed.event.trim()
            ? parsed.event.trim()
            : typeof parsed.code === "string" && parsed.code.trim()
              ? parsed.code.trim()
              : defaultAction;
      const rest = { ...parsed };
      delete rest.level;
      delete rest.ts;
      delete rest.action;
      return { action, data: rest };
    }
  }

  // Single structured object (e.g. console.info({ event: "...", ... }))
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === "object" &&
    !Array.isArray(args[0]) &&
    !(args[0] instanceof Error)
  ) {
    const record = args[0] as Record<string, unknown>;
    const action =
      typeof record.action === "string" && record.action.trim()
        ? record.action.trim()
        : typeof record.event === "string" && record.event.trim()
          ? record.event.trim()
          : typeof record.code === "string" && record.code.trim()
            ? record.code.trim()
            : defaultAction;
    const rest = { ...record };
    delete rest.level;
    delete rest.ts;
    delete rest.action;
    return { action, data: rest };
  }

  const stringParts: string[] = [];
  const details: unknown[] = [];
  let errorObj: Error | undefined;

  for (const arg of args) {
    if (typeof arg === "string") {
      stringParts.push(arg);
    } else if (
      typeof arg === "number" ||
      typeof arg === "boolean" ||
      typeof arg === "bigint"
    ) {
      stringParts.push(String(arg));
    } else if (arg instanceof Error && !errorObj) {
      errorObj = arg;
    } else if (arg !== undefined) {
      details.push(arg);
    }
  }

  const data: Record<string, unknown> = {};
  if (stringParts.length > 0) {
    data.message = stringParts.join(" ");
  }
  if (errorObj) {
    data.error = errorObj;
    const code = (errorObj as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) {
      data.error_code = code.trim();
    }
  }
  if (details.length === 1) {
    data.detail = details[0];
  } else if (details.length > 1) {
    data.details = details;
  }

  return { action: defaultAction, data };
}

function dispatchToPlatformLogger(
  level: LogLevel,
  action: string,
  data: Record<string, unknown>,
): void {
  switch (level) {
    case "debug":
      logger.debug(action, data);
      break;
    case "warn":
      logger.warn(action, data);
      break;
    case "error":
      logger.error(action, data);
      break;
    default:
      logger.info(action, data);
      break;
  }
}

/**
 * Installs a re-entrancy-safe bridge routing legacy `console.*` calls through
 * `server/platform/observability/logger.ts` (`P4.2`). Every runtime log line
 * automatically gains ISO timestamps, secret redaction, and `AsyncLocalStorage`
 * correlation fields (`correlation_id`, `oms_order_id`, `wms_order_id`,
 * `shipment_id`, `channel_event_id`, `engine_ref`).
 */
export function installStructuredConsoleBridge(): () => void {
  if (installedOriginals) {
    return uninstallStructuredConsoleBridge;
  }

  const originals: OriginalConsoleMethods = {
    debug: console.debug.bind(console),
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  installedOriginals = originals;

  const wrap = (method: ConsoleMethodName, level: LogLevel) => (...args: unknown[]) => {
    if (inBridge) {
      originals[method](...args);
      return;
    }
    inBridge = true;
    try {
      const { action, data } = normalizeConsoleArgs(method, args);
      dispatchToPlatformLogger(level, action, data);
    } catch {
      originals[method](...args);
    } finally {
      inBridge = false;
    }
  };

  console.debug = wrap("debug", "debug");
  console.log = wrap("log", "info");
  console.info = wrap("info", "info");
  console.warn = wrap("warn", "warn");
  console.error = wrap("error", "error");

  return uninstallStructuredConsoleBridge;
}

export function uninstallStructuredConsoleBridge(): void {
  if (!installedOriginals) return;
  console.debug = installedOriginals.debug;
  console.log = installedOriginals.log;
  console.info = installedOriginals.info;
  console.warn = installedOriginals.warn;
  console.error = installedOriginals.error;
  installedOriginals = null;
}

export function isStructuredConsoleBridgeInstalled(): boolean {
  return installedOriginals !== null;
}
