import { getDatabasePoolSnapshot } from "../db";
import type { PostgresPoolSnapshot } from "./postgres-pool-observability";
import { getSchedulerLockPoolSnapshot } from "./scheduler-lock";

interface ErrorWithCode extends Error {
  code?: unknown;
}

export interface SchedulerFailureContext {
  error: string;
  errorName: string | null;
  errorCode: string | null;
  databasePool: PostgresPoolSnapshot;
  schedulerLockPool: PostgresPoolSnapshot | null;
}

export function buildSchedulerFailureContext(error: unknown): SchedulerFailureContext {
  const normalizedError = normalizeError(error);
  return {
    ...normalizedError,
    databasePool: getDatabasePoolSnapshot(),
    schedulerLockPool: getSchedulerLockPoolSnapshot(),
  };
}

function normalizeError(error: unknown): {
  error: string;
  errorName: string | null;
  errorCode: string | null;
} {
  if (!(error instanceof Error)) {
    return {
      error: String(error),
      errorName: null,
      errorCode: null,
    };
  }

  const errorWithCode = error as ErrorWithCode;
  return {
    error: error.message,
    errorName: error.name || null,
    errorCode: typeof errorWithCode.code === "string" ? errorWithCode.code : null,
  };
}
