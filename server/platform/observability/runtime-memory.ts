import { readFileSync } from "node:fs";
import { getHeapStatistics } from "node:v8";
import type { RequestHandler } from "express";
import { logger } from "./logger";
import { createRuntimeMemoryObserver, type RuntimeMemoryObserver } from "./runtime-memory-observer";

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 10_000;
const MAX_INTERVAL_MS = 300_000;
// Diagnostics must not amplify a blocked log drain; retain counters, not log objects.
const MAX_LOG_BACKLOG_BYTES = 64 * 1024;
let observer: RuntimeMemoryObserver | null = null;

export function resolveRuntimeMemoryConfiguration(environment: NodeJS.ProcessEnv): {
  enabled: boolean; intervalMs: number;
} {
  const interval = Number(environment.RUNTIME_MEMORY_TELEMETRY_INTERVAL_MS);
  return {
    enabled: environment.RUNTIME_MEMORY_TELEMETRY_ENABLED === "true"
      || (environment.NODE_ENV === "production" && environment.RUNTIME_MEMORY_TELEMETRY_ENABLED !== "false"),
    intervalMs: Number.isSafeInteger(interval) && interval >= MIN_INTERVAL_MS && interval <= MAX_INTERVAL_MS
      ? interval : DEFAULT_INTERVAL_MS,
  };
}

export function linuxProcessSwapBytes(status: string): number | null {
  const match = /^VmSwap:\s+(\d+)\s+kB\s*$/m.exec(status);
  if (!match) return null;
  const bytes = Number(match[1]) * 1024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function readRuntimeMemory() {
  const memory = process.memoryUsage();
  const heap = getHeapStatistics();
  let swapBytes: number | null = null;
  if (process.platform === "linux") {
    try { swapBytes = linuxProcessSwapBytes(readFileSync("/proc/self/status", "utf8")); }
    catch { /* Optional OS measurement. Null explicitly means unavailable, not zero. */ }
  }
  return {
    pid: process.pid, uptimeSeconds: Math.round(process.uptime()),
    rss: memory.rss, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal,
    external: memory.external, arrayBuffers: memory.arrayBuffers,
    heapLimit: heap.heap_size_limit, heapPhysical: heap.total_physical_size,
    malloced: heap.malloced_memory, nativeContexts: heap.number_of_native_contexts,
    detachedContexts: heap.number_of_detached_contexts,
    swapBytes, stdoutQueuedBytes: process.stdout.writableLength,
    stderrQueuedBytes: process.stderr.writableLength,
  };
}

/** No inspector, heap dump, forced GC, DB query, or new worker. Opt-out is
 * available, but production defaults on so one deployment yields evidence. */
export function startRuntimeMemoryTelemetry(options: {
  environment?: NodeJS.ProcessEnv;
  readContext?: () => Readonly<Record<string, unknown>>;
  readMemory?: typeof readRuntimeMemory;
  emit?: (action: string, details: Readonly<Record<string, unknown>>) => void;
} = {}): () => void {
  const config = resolveRuntimeMemoryConfiguration(options.environment ?? process.env);
  if (!config.enabled || observer) return () => undefined;
  const emit = options.emit ?? ((action, details) => logger.info(action, details));
  const current = createRuntimeMemoryObserver({
    nowMs: () => performance.now(), readMemory: () => process.memoryUsage(), emit,
  });
  observer = current;
  let skippedReports = 0;
  let samplingFailures = 0;
  let peakStdoutQueuedBytes = 0;
  let peakStderrQueuedBytes = 0;
  const sample = () => {
    try {
      peakStdoutQueuedBytes = Math.max(peakStdoutQueuedBytes, process.stdout.writableLength);
      peakStderrQueuedBytes = Math.max(peakStderrQueuedBytes, process.stderr.writableLength);
      if (process.stdout.writableLength > MAX_LOG_BACKLOG_BYTES || process.stderr.writableLength > MAX_LOG_BACKLOG_BYTES) {
        skippedReports++;
        return;
      }
      current.report({ ...options.readContext?.(), ...(options.readMemory ?? readRuntimeMemory)(),
        intervalMs: config.intervalMs, skippedReports, samplingFailures,
        peakStdoutQueuedBytes, peakStderrQueuedBytes });
      skippedReports = 0;
      samplingFailures = 0;
      peakStdoutQueuedBytes = 0;
      peakStderrQueuedBytes = 0;
    } catch {
      // Diagnostics are best effort and cannot fail startup, a timer, or a job.
      // Surface missing samples on the next successful record, without raw errors.
      samplingFailures++;
    }
  };
  sample();
  const timer = setInterval(sample, config.intervalMs);
  timer.unref();
  return () => { clearInterval(timer); if (observer === current) observer = null; };
}

export function observeRuntimeWork<T>(name: string, work: () => Promise<T>): Promise<T> {
  return observer ? observer.run(name, work) : work();
}

export function runtimeRequestCategory(method: string, path: string): string {
  if (path.includes("/webhooks/")) return "http.webhook";
  if (path.startsWith("/api/internal/")) return "http.internal";
  if (path.startsWith("/api/")) return method === "GET" ? "http.api_read" : "http.api_write";
  return "http.other";
}

/** Install before body parsing. Records only numeric counters in fixed groups;
 * never capture a request, response body, query string, customer, or credential. */
export const observeRuntimeRequests: RequestHandler = (req, res, next) => {
  if (observer) {
    const finish = observer.begin(runtimeRequestCategory(req.method, req.path), false);
    const complete = () => {
      res.off("finish", complete);
      res.off("close", complete);
      finish(res.writableFinished && res.statusCode < 500 ? "completed" : "failed");
    };
    res.once("finish", complete);
    res.once("close", complete);
  }
  next();
};
