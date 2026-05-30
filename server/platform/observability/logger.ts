import { getContext } from "./log-context";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
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

function emit(entry: LogEntry): void {
  const ctx = getContext();
  const line = {
    ts: new Date().toISOString(),
    ...entry,
    ...(ctx ?? {}),
  };

  const json = JSON.stringify(line);

  switch (entry.level) {
    case "error":
      process.stderr.write(json + "\n");
      break;
    case "warn":
      process.stderr.write(json + "\n");
      break;
    default:
      process.stdout.write(json + "\n");
      break;
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
