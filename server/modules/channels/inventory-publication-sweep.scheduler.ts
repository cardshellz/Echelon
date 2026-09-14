export interface InventoryPublicationSweepControl {
  globalEnabled: boolean;
  sweepIntervalMinutes: number;
}

export interface InventoryPublicationSweepSchedulerLogger {
  info(message: string): void;
  error(message: string): void;
}

export interface InventoryPublicationSweepSchedulerHandle {
  refresh(): Promise<void>;
  stop(): void;
}

export interface InventoryPublicationSweepSchedulerOptions {
  controlPollIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_CONTROL_POLL_INTERVAL_MS = 60_000;
const MINUTE_MS = 60_000;

/**
 * Supervises scheduled inventory publication from durable global control.
 *
 * The supervisor deliberately keeps polling while publication is disabled so
 * an audited enable command takes effect without a process restart. It also
 * recalculates the next due time whenever the durable interval changes.
 */
export function startInventoryPublicationSweepScheduler(
  dependencies: {
    readControl(): Promise<InventoryPublicationSweepControl>;
    runSweep(): Promise<void>;
    logger: InventoryPublicationSweepSchedulerLogger;
  },
  options: InventoryPublicationSweepSchedulerOptions = {},
): InventoryPublicationSweepSchedulerHandle {
  const controlPollIntervalMs = positiveInteger(
    options.controlPollIntervalMs ?? DEFAULT_CONTROL_POLL_INTERVAL_MS,
    "controlPollIntervalMs",
  );
  const now = options.now ?? Date.now;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let checking = false;
  let refreshRequested = false;
  let enabled = false;
  let activeIntervalMs: number | null = null;
  let lastSweepStartedAtMs: number | null = null;
  let nextSweepDueAtMs: number | null = null;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void checkControl();
    }, Math.max(1, delayMs));
    timer.unref?.();
  };

  const scheduleNextCheck = (): void => {
    if (refreshRequested) {
      refreshRequested = false;
      schedule(1);
      return;
    }
    const currentTime = validNow(now());
    const untilSweep = enabled && nextSweepDueAtMs !== null
      ? Math.max(1, nextSweepDueAtMs - currentTime)
      : controlPollIntervalMs;
    schedule(Math.min(controlPollIntervalMs, untilSweep));
  };

  const checkControl = async (): Promise<void> => {
    if (stopped) return;
    if (checking) {
      refreshRequested = true;
      return;
    }
    checking = true;
    try {
      const control = await dependencies.readControl();
      const intervalMs = validatedIntervalMs(control.sweepIntervalMinutes);
      const currentTime = validNow(now());

      if (!control.globalEnabled) {
        if (enabled) {
          dependencies.logger.info("Inventory publication scheduler disabled by durable global control.");
        }
        enabled = false;
        activeIntervalMs = intervalMs;
        nextSweepDueAtMs = null;
        return;
      }

      const wasEnabled = enabled;
      const intervalChanged = activeIntervalMs !== null && activeIntervalMs !== intervalMs;
      enabled = true;
      activeIntervalMs = intervalMs;

      if (!wasEnabled) {
        nextSweepDueAtMs = currentTime;
        dependencies.logger.info(
          `Inventory publication scheduler enabled with a ${control.sweepIntervalMinutes}-minute interval.`,
        );
      } else if (intervalChanged) {
        nextSweepDueAtMs = lastSweepStartedAtMs === null
          ? currentTime
          : lastSweepStartedAtMs + intervalMs;
        dependencies.logger.info(
          `Inventory publication scheduler interval changed to ${control.sweepIntervalMinutes} minutes.`,
        );
      }

      if (nextSweepDueAtMs === null || currentTime >= nextSweepDueAtMs) {
        lastSweepStartedAtMs = currentTime;
        nextSweepDueAtMs = currentTime + intervalMs;
        await dependencies.runSweep();
      }
    } catch (error) {
      dependencies.logger.error(
        `Inventory publication scheduler control check failed: ${safeErrorMessage(error)}`,
      );
    } finally {
      checking = false;
      if (!stopped) scheduleNextCheck();
    }
  };

  void checkControl();

  return {
    async refresh(): Promise<void> {
      if (stopped) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await checkControl();
    },
    stop(): void {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function validatedIntervalMs(minutes: number): number {
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440) {
    throw new Error("sweepIntervalMinutes must be an integer between 1 and 1440");
  }
  return minutes * MINUTE_MS;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function validNow(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Scheduler clock returned an invalid timestamp");
  }
  return value;
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
