import { getContext } from "./log-context";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const SENSITIVE_KEY_PATTERN =
  /^(?:password|passwd|pwd|secret|client_secret|webhook_secret|signing_secret|access_token|refresh_token|id_token|auth_token|token|api_key|apikey|private_key|privatekey|authorization|cookie|set-cookie|x-shopify-access-token|x-ebay-signature)$/i;

const MAX_SANITIZE_DEPTH = 8;

export function resolveLogLevel(raw: unknown, fallback: LogLevel = "info"): LogLevel {
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEVEL_ORDER, normalized)) {
      return normalized as LogLevel;
    }
  }
  return fallback;
}

let minLevel: LogLevel = resolveLogLevel(process.env.LOG_LEVEL, "info");

export function setLogLevel(level: LogLevel | string): void {
  minLevel = resolveLogLevel(level, "info");
}

export function getLogLevel(): LogLevel {
  return minLevel;
}

function shouldLog(level: LogLevel): boolean {
  const targetOrder = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  const thresholdOrder = LEVEL_ORDER[minLevel] ?? LEVEL_ORDER.info;
  return targetOrder >= thresholdOrder;
}

export function isSensitiveLogKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key.trim());
}

function sanitizeValue(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "symbol" || typeof value === "function") {
    return String(value);
  }

  if (typeof value !== "object") {
    return String(value);
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }

  if (ancestors.has(value)) {
    return "[Circular]";
  }

  if (depth >= MAX_SANITIZE_DEPTH) {
    return "[MaxDepth]";
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, ancestors, depth + 1));
    }

    if (value instanceof Error) {
      const errRecord: Record<string, unknown> = {
        name: value.name,
        message: value.message,
      };
      if (value.stack) {
        errRecord.stack = value.stack;
      }
      for (const key of Object.keys(value)) {
        if (key === "name" || key === "message" || key === "stack") continue;
        if (isSensitiveLogKey(key)) {
          errRecord[key] = "[REDACTED]";
        } else {
          try {
            errRecord[key] = sanitizeValue((value as unknown as Record<string, unknown>)[key], ancestors, depth + 1);
          } catch {
            errRecord[key] = "[Unserializable]";
          }
        }
      }
      return errRecord;
    }

    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (isSensitiveLogKey(key)) {
        const rawField = (value as Record<string, unknown>)[key];
        out[key] = rawField === null || rawField === undefined ? rawField : "[REDACTED]";
        continue;
      }
      try {
        const rawField = (value as Record<string, unknown>)[key];
        out[key] = sanitizeValue(rawField, ancestors, depth + 1);
      } catch {
        out[key] = "[Unserializable]";
      }
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

export function redactLogData<T extends Record<string, unknown>>(data: T): Record<string, unknown> {
  const sanitized = sanitizeValue(data, new WeakSet<object>(), 0);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return {};
}

export interface LogEntry {
  level: LogLevel;
  action: string;
  outcome?: string;
  before?: unknown;
  after?: unknown;
  error_code?: string;
  error_class?: string;
  [key: string]: unknown;
}

function serializeLogLine(line: Record<string, unknown>, fallbackLevel: LogLevel, fallbackAction: string): string {
  try {
    const sanitized = redactLogData(line);
    return JSON.stringify(sanitized, (_key, val) => (typeof val === "bigint" ? val.toString() : val));
  } catch {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: fallbackLevel,
      action: fallbackAction,
      log_serialization_error: true,
    });
  }
}

function emit(entry: LogEntry): void {
  try {
    const ctx = getContext();
    const rawLine: Record<string, unknown> = {
      ts: new Date().toISOString(),
      ...entry,
      ...(ctx ?? {}),
    };

    const json = serializeLogLine(rawLine, entry.level, String(entry.action ?? "unknown"));

    switch (entry.level) {
      case "error":
      case "warn":
        process.stderr.write(json + "\n");
        break;
      default:
        process.stdout.write(json + "\n");
        break;
    }
  } catch {
    // Logger must never throw or alter business control flow.
  }
}

export const logger = {
  debug(action: string, data?: Omit<LogEntry, "level" | "action">): void {
    if (!shouldLog("debug")) return;
    emit({ level: "debug", action, ...data });
  },

  info(action: string, data?: Omit<LogEntry, "level" | "action">): void {
    if (!shouldLog("info")) return;
    emit({ level: "info", action, ...data });
  },

  warn(action: string, data?: Omit<LogEntry, "level" | "action">): void {
    if (!shouldLog("warn")) return;
    emit({ level: "warn", action, ...data });
  },

  error(action: string, data?: Omit<LogEntry, "level" | "action">): void {
    if (!shouldLog("error")) return;
    emit({ level: "error", action, ...data });
  },
};
