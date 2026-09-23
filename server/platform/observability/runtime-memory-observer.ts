/** Process-level correlation, not per-job allocation accounting. Concurrent jobs
 * and garbage collection can change every delta. Never retain work/results/errors. */
export interface RuntimeMemoryPoint {
  rss: number;
  heapUsed: number;
  external: number;
}

// Covers the current named jobs, advisory-lock domains and five HTTP buckets,
// with headroom for additions but no unbounded per-order/provider cardinality.
export const MAX_RUNTIME_MEMORY_GROUPS = 64;
const OTHER_GROUP = "other";
type Outcome = "completed" | "failed";
type Emit = (action: string, data: Readonly<Record<string, unknown>>) => void;

interface WorkGroup {
  active: number;
  peakActive: number;
  started: number;
  completed: number;
  failed: number;
  overlappingStarts: number;
  maxDurationMs: number;
  maxRssDelta: number | null;
  maxHeapDelta: number | null;
  maxExternalDelta: number | null;
}

function newGroup(): WorkGroup {
  return { active: 0, peakActive: 0, started: 0, completed: 0, failed: 0,
    overlappingStarts: 0, maxDurationMs: 0, maxRssDelta: null,
    maxHeapDelta: null, maxExternalDelta: null };
}

export function createRuntimeMemoryObserver(dependencies: {
  readMemory(): RuntimeMemoryPoint;
  nowMs(): number;
  emit: Emit;
}) {
  // Finite cardinality even if a future caller accidentally supplies row-scoped names.
  const groups = new Map<string, WorkGroup>([[OTHER_GROUP, newGroup()]]);
  let active = 0;
  let failures = 0;
  let reportSequence = 0;
  const attempt = <T>(work: () => T): T | null => {
    try { return work(); } catch { failures++; return null; }
  };
  const now = () => attempt(() => {
    const value = dependencies.nowMs();
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid diagnostic clock");
    return value;
  });
  const memory = () => attempt(() => {
    const value = dependencies.readMemory();
    for (const key of ["rss", "heapUsed", "external"] as const) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error("Invalid memory measurement");
    }
    // Copy only numeric measurements, never an arbitrary dependency-owned object.
    return { rss: value.rss, heapUsed: value.heapUsed, external: value.external };
  });

  function begin(name: string, measureMemory = true): (outcome: Outcome) => void {
    const safeName = typeof name === "string" && /^[a-z][a-z0-9_.:-]{0,79}$/.test(name) ? name : OTHER_GROUP;
    const key = groups.has(safeName) || groups.size < MAX_RUNTIME_MEMORY_GROUPS ? safeName : OTHER_GROUP;
    let group = groups.get(key);
    if (!group) { group = newGroup(); groups.set(key, group); }
    const counters = group;
    if (active > 0) counters.overlappingStarts++;
    active++;
    counters.active++;
    counters.peakActive = Math.max(counters.peakActive, counters.active);
    counters.started++;
    const startedAt = now();
    const before = measureMemory ? memory() : null;
    let finished = false;
    return outcome => {
      if (finished) return;
      finished = true;
      active--;
      counters.active--;
      counters[outcome]++;
      const finishedAt = now();
      if (startedAt !== null && finishedAt !== null) {
        counters.maxDurationMs = Math.max(counters.maxDurationMs, Math.max(0, Math.round(finishedAt - startedAt)));
      }
      const after = measureMemory ? memory() : null;
      if (before && after) {
        const max = (previous: number | null, value: number) => previous === null ? value : Math.max(previous, value);
        counters.maxRssDelta = max(counters.maxRssDelta, after.rss - before.rss);
        counters.maxHeapDelta = max(counters.maxHeapDelta, after.heapUsed - before.heapUsed);
        counters.maxExternalDelta = max(counters.maxExternalDelta, after.external - before.external);
      }
    };
  }

  return {
    begin,
    async run<T>(name: string, work: () => Promise<T>): Promise<T> {
      const finish = begin(name);
      try {
        const result = await work();
        finish("completed");
        return result;
      } catch (error) {
        finish("failed");
        throw error;
      }
    },
    /** At most one process record and MAX_RUNTIME_MEMORY_GROUPS small work
     * records per interval. No per-request/per-tick log stream or history buffer. */
    report(details: Readonly<Record<string, unknown>>): void {
      reportSequence++;
      const telemetryFailures = failures;
      failures = 0;
      attempt(() => dependencies.emit("runtime.memory", {
        ...details, reportSequence, activeWork: active, telemetryFailures,
      }));
      for (const [name, group] of groups) {
        if (group.active || group.started || group.completed || group.failed) {
          attempt(() => dependencies.emit("runtime.work_memory", {
            reportSequence, name, ...group, deltaScope: "whole_process_not_exclusive",
          }));
        }
        // Keep in-flight gauges across reporting windows, not completed history.
        Object.assign(group, newGroup(), { active: group.active, peakActive: group.active });
      }
    },
  };
}

export type RuntimeMemoryObserver = ReturnType<typeof createRuntimeMemoryObserver>;
