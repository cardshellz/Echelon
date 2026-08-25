export interface NonOverlappingSchedulerHandle {
  stop(): void;
}

export interface NonOverlappingSchedulerLogger {
  error(payload: {
    code: string;
    message: string;
    context: {
      taskName: string;
      error: string;
    };
  }): void;
}

export interface NonOverlappingSchedulerOptions {
  taskName: string;
  initialDelayMs: number;
  intervalMs: number;
  run: () => Promise<void>;
  logger?: NonOverlappingSchedulerLogger;
}

/**
 * Starts one in-process task loop. The interval is measured from completion,
 * so a slow run cannot overlap with or build a backlog behind itself.
 * Cross-process exclusivity remains the responsibility of the task's
 * advisory lock.
 */
export function startNonOverlappingScheduler(
  options: NonOverlappingSchedulerOptions,
): NonOverlappingSchedulerHandle {
  const taskName = nonBlankString(options.taskName, "taskName");
  const initialDelayMs = nonNegativeInteger(options.initialDelayMs, "initialDelayMs");
  const intervalMs = positiveInteger(options.intervalMs, "intervalMs");
  const logger = options.logger ?? console;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void execute();
    }, delayMs);
    timer.unref?.();
  };

  const execute = async (): Promise<void> => {
    if (stopped) return;
    try {
      await options.run();
    } catch (error) {
      logger.error({
        code: "NON_OVERLAPPING_SCHEDULED_TASK_FAILED",
        message: "A scheduled task escaped its task-level error boundary.",
        context: {
          taskName,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      schedule(intervalMs);
    }
  };

  schedule(initialDelayMs);

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function nonBlankString(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-blank string`);
  }
  return normalized;
}
