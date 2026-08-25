import {
  startNonOverlappingScheduler,
  type NonOverlappingSchedulerHandle,
} from "../../../infrastructure/non-overlapping-scheduler";

export type DropshipWorkerScheduleName =
  | "listingPush"
  | "orderProcessing"
  | "ebayOrderIntake"
  | "returnIntake"
  | "returnsMaintenance";

interface DropshipWorkerScheduleDefinition {
  initialDelayEnvironmentVariable: string;
  defaultInitialDelayMs: number;
}

const SCHEDULE_DEFINITIONS: Record<
  DropshipWorkerScheduleName,
  DropshipWorkerScheduleDefinition
> = {
  // High-frequency queue workers use opposite halves of their ten-second cycle.
  listingPush: {
    initialDelayEnvironmentVariable: "DROPSHIP_LISTING_PUSH_WORKER_INITIAL_DELAY_MS",
    defaultInitialDelayMs: 2_000,
  },
  orderProcessing: {
    initialDelayEnvironmentVariable: "DROPSHIP_ORDER_PROCESSING_WORKER_INITIAL_DELAY_MS",
    defaultInitialDelayMs: 7_000,
  },
  // Polling and maintenance workers are separated from each other and from the
  // application boot burst. Operators can override each phase independently.
  ebayOrderIntake: {
    initialDelayEnvironmentVariable: "DROPSHIP_EBAY_ORDER_INTAKE_WORKER_INITIAL_DELAY_MS",
    defaultInitialDelayMs: 30_000,
  },
  returnIntake: {
    initialDelayEnvironmentVariable: "DROPSHIP_RETURN_INTAKE_WORKER_INITIAL_DELAY_MS",
    defaultInitialDelayMs: 90_000,
  },
  returnsMaintenance: {
    initialDelayEnvironmentVariable: "DROPSHIP_RETURNS_MAINTENANCE_WORKER_INITIAL_DELAY_MS",
    defaultInitialDelayMs: 150_000,
  },
};

export interface DropshipWorkerSchedule {
  initialDelayMs: number;
  initialDelayEnvironmentVariable: string;
}

export function resolveDropshipWorkerSchedule(
  name: DropshipWorkerScheduleName,
  environment: NodeJS.ProcessEnv = process.env,
): DropshipWorkerSchedule {
  const definition = SCHEDULE_DEFINITIONS[name];
  const configuredText = environment[definition.initialDelayEnvironmentVariable];
  const configuredValue = configuredText !== undefined && configuredText.trim().length > 0
    ? Number(configuredText)
    : Number.NaN;
  const initialDelayMs = Number.isSafeInteger(configuredValue) && configuredValue >= 0
    ? configuredValue
    : definition.defaultInitialDelayMs;

  return {
    initialDelayMs,
    initialDelayEnvironmentVariable: definition.initialDelayEnvironmentVariable,
  };
}

export function startDropshipWorkerSchedule(input: {
  name: DropshipWorkerScheduleName;
  intervalMs: number;
  run: () => Promise<void>;
  environment?: NodeJS.ProcessEnv;
}): {
  handle: NonOverlappingSchedulerHandle;
  initialDelayMs: number;
} {
  const schedule = resolveDropshipWorkerSchedule(input.name, input.environment);
  return {
    initialDelayMs: schedule.initialDelayMs,
    handle: startNonOverlappingScheduler({
      taskName: `dropship-${input.name}`,
      initialDelayMs: schedule.initialDelayMs,
      intervalMs: input.intervalMs,
      run: input.run,
    }),
  };
}
