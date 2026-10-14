export const POSTGRES_TIMING_FILE_PATTERN = /^server\/(?:[a-zA-Z0-9_-]+\/)*__tests__\/integration\/[a-zA-Z0-9_.-]+\.test\.ts$/;
// A measured file cannot exceed the existing CI job's twenty-minute timeout.
export const MAX_POSTGRES_FILE_DURATION_MS = 20 * 60 * 1000;

export interface PlannedPostgresShard {
  readonly files: readonly string[];
  readonly estimatedDurationMs: number;
}

export interface PostgresShardPlan {
  readonly shards: readonly PlannedPostgresShard[];
  readonly fallbackDurationMs: number;
  readonly unmeasuredFiles: readonly string[];
  readonly unusedTimingFiles: readonly string[];
}

function comparePaths(left: string, right: string): number {
  // Repository paths are ASCII. Do not let the runner's locale change a tie.
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Timing evidence influences placement only. The manifest remains the complete
 * coverage authority, including new files absent from the timing snapshot. */
export function planPostgresShards(
  files: readonly string[],
  durations: Readonly<Record<string, number>>,
  shardCount: number,
): PostgresShardPlan {
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || !Array.isArray(files) || files.length < shardCount
      || files.some((file) => typeof file !== "string" || !POSTGRES_TIMING_FILE_PATTERN.test(file))
      || new Set(files).size !== files.length) {
    throw new Error("PostgreSQL shard planning requires unique explicit suite paths and at least one file per shard.");
  }
  if (!durations || typeof durations !== "object" || Array.isArray(durations)) {
    throw new Error("PostgreSQL timing weights must be a nonempty file-to-milliseconds object.");
  }
  const measured = Object.entries(durations);
  if (measured.length === 0 || measured.some(([file, duration]) => !POSTGRES_TIMING_FILE_PATTERN.test(file)
      || !Number.isSafeInteger(duration) || duration <= 0 || duration > MAX_POSTGRES_FILE_DURATION_MS)) {
    throw new Error("PostgreSQL timing weights require explicit suite paths and positive integer milliseconds within the CI timeout.");
  }
  // Unknown work is budgeted as the slowest observed suite, never zero or an
  // invented measurement. Refresh the snapshot after new coverage passes CI.
  const fallbackDurationMs = measured.reduce((maximum, [, duration]) => Math.max(maximum, duration), 0);
  const work = files.map((file) => ({ file, durationMs: Object.hasOwn(durations, file) ? durations[file] : fallbackDurationMs }))
    .sort((left, right) => right.durationMs - left.durationMs || comparePaths(left.file, right.file));
  const shards = Array.from({ length: shardCount }, () => ({ files: [] as string[], estimatedDurationMs: 0 }));
  for (const item of work) {
    let selected = 0;
    for (let index = 1; index < shards.length; index += 1) {
      // The lower shard index wins ties, independent of manifest order.
      if (shards[index].estimatedDurationMs < shards[selected].estimatedDurationMs) selected = index;
    }
    const shard = shards[selected];
    shard.files.push(item.file);
    shard.estimatedDurationMs += item.durationMs;
    if (!Number.isSafeInteger(shard.estimatedDurationMs)) throw new Error("PostgreSQL shard duration exceeds the exact integer range.");
  }
  const manifest = new Set(files);
  return Object.freeze({
    shards: Object.freeze(shards.map((shard) => Object.freeze({
      files: Object.freeze(shard.files), estimatedDurationMs: shard.estimatedDurationMs,
    }))),
    fallbackDurationMs,
    unmeasuredFiles: Object.freeze(files.filter((file) => !Object.hasOwn(durations, file)).sort(comparePaths)),
    unusedTimingFiles: Object.freeze(measured.map(([file]) => file).filter((file) => !manifest.has(file)).sort(comparePaths)),
  });
}
