import { randomUUID } from "node:crypto";
import { createSideChannelPool } from "../../../db";
import { logger as platformLogger } from "../../../platform/observability/logger";
import {
  DROPSHIP_CATALOG_CODE_VERSION,
  OLDER_PROCESS_ALERT_AFTER_MS,
  OLDER_PROCESS_GRACE_MS,
} from "../domain/catalog-code-version";
import {
  deleteStaleProcessHeartbeats,
  listOlderProcessesStillRunning,
  writeProcessHeartbeat,
  type ProcessHeartbeatRow,
} from "./dropship-process-heartbeat.repository";

/**
 * The process heartbeat (step 1 plan S2-5 §4.9 item 1, D37, CHK2, CHK10).
 *
 * Every web process records which catalog code version it runs, so a later
 * release can wait by itself until no older process is alive (B's picks
 * writes, C's end worker): no person checks dynos or flips a flag (owner
 * decision 7).
 *
 * - It starts as the first statement of the listen callback and its first
 *   beat is awaited (at most PROCESS_HEARTBEAT_FIRST_WRITE_TIMEOUT_MS) before
 *   any worker starts, so a process is never planning stock or pushing
 *   listings without being counted. It is not a scheduler: DISABLE_SCHEDULERS
 *   does not stop it (a process without workers still serves selection reads
 *   and the old rules save).
 * - It never deletes its row and adds no signal listener: after SIGTERM the
 *   web process keeps serving and running its workers until it is killed
 *   (F31), so its row must stay fresh while it lives. A row ages out after
 *   the grace, and an hourly cleanup deletes rows not seen for a day.
 * - A failed write is retried at the next beat; nothing waits on it. A write
 *   that does not settle within PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS counts as
 *   failed and frees the next beat, so one stuck connection can never stop
 *   the beats for the rest of the process's life (verify V5). Writes go on a
 *   one-connection pool of their own with statement and query timeouts and
 *   TCP keepalive, so a busy shared pool cannot starve them.
 * - When the beats keep failing long enough for a later release to take this
 *   process for gone (half the grace), that is an ERROR: a human must look.
 */
export const PROCESS_HEARTBEAT_INTERVAL_MS = 30_000;
export const PROCESS_HEARTBEAT_FIRST_WRITE_TIMEOUT_MS = 5_000;
/** A beat that has not settled by then counts as failed (well inside the interval). */
export const PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS = 10_000;
/**
 * Failed beats in a row after which the process's row is half way to the
 * grace a later release waits (OLDER_PROCESS_GRACE_MS / 2 / interval): logged
 * once at ERROR, since the row ages out at the grace while the process lives.
 */
export const PROCESS_HEARTBEAT_ALERT_AFTER_FAILURES = Math.ceil(OLDER_PROCESS_GRACE_MS / 2 / PROCESS_HEARTBEAT_INTERVAL_MS);
/** The heartbeat's own pool: one connection, every statement bounded below the write timeout. */
const HEARTBEAT_POOL_CONFIG = {
  max: 1,
  statementTimeoutMs: 5_000,
  queryTimeoutMs: 8_000,
  connectionTimeoutMs: 5_000,
  // Longer than the interval, so the beats reuse one connection.
  idleTimeoutMs: 2 * PROCESS_HEARTBEAT_INTERVAL_MS,
} as const;
export const PROCESS_HEARTBEAT_MAINTENANCE_INTERVAL_MS = 60 * 60_000;
/** A row not seen for a day is a process that is long gone. */
export const PROCESS_HEARTBEAT_RETENTION_MS = 24 * 60 * 60_000;

export interface DropshipProcessHeartbeatStore {
  beat(input: { processKey: string; catalogCodeVersion: number }): Promise<void>;
  deleteStale(input: { olderThanMs: number }): Promise<number>;
  listOlderStillRunning(input: { version: number; graceMs: number; alertAfterMs: number }): Promise<ProcessHeartbeatRow[]>;
}

export interface DropshipProcessHeartbeatLogger {
  debug(action: string, data: Record<string, unknown>): void;
  info(action: string, data: Record<string, unknown>): void;
  warn(action: string, data: Record<string, unknown>): void;
  error(action: string, data: Record<string, unknown>): void;
}

/** Injected so tests drive every beat and every wait (CLAUDE.md §3). */
export interface DropshipProcessHeartbeatTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface StartDropshipProcessHeartbeatInput {
  store: DropshipProcessHeartbeatStore;
  logger: DropshipProcessHeartbeatLogger;
  timers: DropshipProcessHeartbeatTimers;
  processKey: string;
  catalogCodeVersion?: number;
}

export type ProcessHeartbeatFirstBeat = "written" | "failed" | "timed_out";

export interface DropshipProcessHeartbeatHandle {
  processKey: string;
  catalogCodeVersion: number;
  firstBeat: ProcessHeartbeatFirstBeat;
  /** Stops the timers; the row stays (it ages out). For tests and an orderly shutdown only. */
  stop(): void;
}

/**
 * Writes the first beat (bounded by the first-write timeout), then beats on
 * the interval and runs the hourly maintenance. Never throws: a database that
 * cannot be reached must not stop the server from starting.
 */
export async function startDropshipProcessHeartbeat(
  input: StartDropshipProcessHeartbeatInput,
): Promise<DropshipProcessHeartbeatHandle> {
  const version = input.catalogCodeVersion ?? DROPSHIP_CATALOG_CODE_VERSION;
  const context = { process_key: input.processKey, catalog_code_version: version };
  let beatInFlight: Promise<boolean> | null = null;
  let consecutiveFailures = 0;
  let stopped = false;

  const beat = (): Promise<boolean> => {
    // One beat at a time: a slow database never stacks writes from one process.
    if (beatInFlight) return beatInFlight;
    const current = settleWithin(input.store.beat({ processKey: input.processKey, catalogCodeVersion: version }),
      input.timers, PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS)
      .then((settled) => {
        if (settled === "timed_out") {
          failed("DROPSHIP_PROCESS_HEARTBEAT_WRITE_TIMED_OUT",
            `The heartbeat write did not settle within ${PROCESS_HEARTBEAT_WRITE_TIMEOUT_MS} ms.`);
          return false;
        }
        if (consecutiveFailures > 0) {
          input.logger.info("dropship.process_heartbeat.recovered", { ...context, outcome: "written", failed_beats: consecutiveFailures });
        }
        consecutiveFailures = 0;
        return true;
      }, (error: unknown) => {
        failed("DROPSHIP_PROCESS_HEARTBEAT_WRITE_FAILED", error instanceof Error ? error.message : String(error));
        return false;
      })
      // A beat abandoned by its timeout frees the slot; when it settles later it never clears a newer beat's slot.
      .finally(() => { if (beatInFlight === current) beatInFlight = null; });
    beatInFlight = current;
    return current;
  };

  /**
   * WARN at the first failure of a streak (an anomaly the next beat retries);
   * ERROR once when the streak reaches PROCESS_HEARTBEAT_ALERT_AFTER_FAILURES
   * (needs a human: a later release could take this live process for gone);
   * DEBUG while it lasts.
   */
  const failed = (errorCode: string, message: string): void => {
    consecutiveFailures += 1;
    const entry = { ...context, outcome: "retry_next_beat", error_code: errorCode, error_class: "transient",
      error_message: message, failed_beats: consecutiveFailures };
    if (consecutiveFailures === 1) {
      input.logger.warn("dropship.process_heartbeat.write_failed", entry);
    } else if (consecutiveFailures === PROCESS_HEARTBEAT_ALERT_AFTER_FAILURES) {
      input.logger.error("dropship.process_heartbeat.write_failing", { ...entry, outcome: "row_ageing",
        grace_ms: OLDER_PROCESS_GRACE_MS });
    } else {
      input.logger.debug("dropship.process_heartbeat.write_failed", entry);
    }
  };

  const maintain = async (): Promise<void> => {
    try {
      const deleted = await input.store.deleteStale({ olderThanMs: PROCESS_HEARTBEAT_RETENTION_MS });
      if (deleted > 0) input.logger.debug("dropship.process_heartbeat.stale_rows_deleted", { ...context, deleted });
      const older = await input.store.listOlderStillRunning({
        version, graceMs: OLDER_PROCESS_GRACE_MS, alertAfterMs: OLDER_PROCESS_ALERT_AFTER_MS,
      });
      if (older.length > 0) {
        // ERROR: needs a human (§3.1). A later release's gates stay closed while it lasts.
        input.logger.error("dropship.release.older_process_still_running", {
          ...context, outcome: "older_process_alive", error_code: "DROPSHIP_RELEASE_OLDER_PROCESS_STILL_RUNNING",
          error_class: "fatal",
          older_processes: older.map((row) => ({
            process_key: row.processKey, catalog_code_version: row.catalogCodeVersion,
            started_at: row.startedAt.toISOString(), last_seen_at: row.lastSeenAt.toISOString(),
          })),
        });
      }
    } catch (error) {
      input.logger.warn("dropship.process_heartbeat.maintenance_failed", {
        ...context, outcome: "retry_next_hour", error_code: "DROPSHIP_PROCESS_HEARTBEAT_MAINTENANCE_FAILED",
        error_class: "transient", error_message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const firstBeat = await firstBeatWithin(beat(), input.timers, PROCESS_HEARTBEAT_FIRST_WRITE_TIMEOUT_MS);
  if (firstBeat === "written") {
    input.logger.info("dropship.process_heartbeat.started", { ...context, outcome: "written" });
  } else if (firstBeat === "timed_out") {
    // The beat keeps going in the background; the server starts anyway.
    input.logger.warn("dropship.process_heartbeat.first_write_timed_out", {
      ...context, outcome: "continued", error_code: "DROPSHIP_PROCESS_HEARTBEAT_FIRST_WRITE_TIMEOUT",
      error_class: "transient", timeout_ms: PROCESS_HEARTBEAT_FIRST_WRITE_TIMEOUT_MS,
    });
  }
  const beatTimer = unrefTimer(input.timers.setInterval(() => { void beat(); }, PROCESS_HEARTBEAT_INTERVAL_MS));
  const maintenanceTimer = unrefTimer(input.timers.setInterval(() => { void maintain(); }, PROCESS_HEARTBEAT_MAINTENANCE_INTERVAL_MS));

  return {
    processKey: input.processKey,
    catalogCodeVersion: version,
    firstBeat,
    stop: () => {
      if (stopped) return;
      stopped = true;
      input.timers.clearInterval(beatTimer);
      input.timers.clearInterval(maintenanceTimer);
    },
  };
}

/** The process's identity: its dyno name and a boot id (an identity only; no outcome depends on it). */
export function dropshipProcessKey(dyno: string | undefined, bootId: string): string {
  const name = dyno?.trim() || "local";
  return `${name}:${bootId}`;
}

/**
 * The production heartbeat: a one-connection pool of its own (one statement
 * per beat; verify V5), the platform JSON logger and real timers.
 */
export function startDropshipProcessHeartbeatFromEnv(): Promise<DropshipProcessHeartbeatHandle> {
  const heartbeatPool = createSideChannelPool(HEARTBEAT_POOL_CONFIG);
  // An idle connection's error must not crash the process; the next beat reconnects (WARN: recovered by itself).
  heartbeatPool.on("error", (error: Error) => {
    platformLogger.warn("dropship.process_heartbeat.pool_error", {
      outcome: "reconnect_next_beat", error_code: "DROPSHIP_PROCESS_HEARTBEAT_POOL_ERROR", error_class: "transient",
      error_message: error.message,
    });
  });
  const store: DropshipProcessHeartbeatStore = {
    beat: (beatInput) => writeProcessHeartbeat(heartbeatPool, beatInput),
    deleteStale: (deleteInput) => deleteStaleProcessHeartbeats(heartbeatPool, deleteInput),
    listOlderStillRunning: (listInput) => listOlderProcessesStillRunning(heartbeatPool, listInput),
  };
  return startDropshipProcessHeartbeat({
    store,
    logger: platformLogger,
    timers: {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    processKey: dropshipProcessKey(process.env.DYNO, randomUUID()),
  });
}

/** The work's outcome, or "timed_out" when it has not settled within the time (it keeps running; its result is dropped). */
async function settleWithin<T>(work: Promise<T>, timers: DropshipProcessHeartbeatTimers, timeoutMs: number): Promise<T | "timed_out"> {
  let timeout: unknown = null;
  const timedOut = new Promise<"timed_out">((resolve) => {
    timeout = timers.setTimeout(() => resolve("timed_out"), timeoutMs);
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    timers.clearTimeout(timeout);
  }
}

async function firstBeatWithin(
  beat: Promise<boolean>,
  timers: DropshipProcessHeartbeatTimers,
  timeoutMs: number,
): Promise<ProcessHeartbeatFirstBeat> {
  let timeout: unknown = null;
  const timedOut = new Promise<"timed_out">((resolve) => {
    timeout = timers.setTimeout(() => resolve("timed_out"), timeoutMs);
  });
  try {
    const outcome = beat.then((written): ProcessHeartbeatFirstBeat => (written ? "written" : "failed"));
    return await Promise.race([outcome, timedOut]);
  } finally {
    timers.clearTimeout(timeout);
  }
}

/** A heartbeat alone never keeps a process alive (real timers only; injected test timers have no unref). */
function unrefTimer(handle: unknown): unknown {
  if (handle && typeof (handle as { unref?: unknown }).unref === "function") (handle as { unref: () => void }).unref();
  return handle;
}
