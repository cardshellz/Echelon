import { buildSchedulerFailureContext } from "../../../infrastructure/scheduler-failure-context";
import { withAdvisoryLock } from "../../../infrastructure/scheduler-lock";
import {
  DEFAULT_COST_NOTICE_GROUPS_PER_PASS,
  MAX_COST_NOTICE_GROUPS_PER_PASS,
  type DropshipCostNoticePassResult,
} from "../application/dropship-cost-change-notice-service";
import {
  DEFAULT_COST_DETECTION_VENDORS_PER_TICK,
  type DropshipCostDetectionTickResult,
} from "../application/dropship-cost-detection-service";
import { createDropshipCostChangeNoticeServiceFromEnv } from "./dropship-cost-change-notice.factory";
import { isDropshipCostDetectionWorkerEnabled } from "./dropship-cost-detection-config";
import { createDropshipCostDetectionServiceFromEnv } from "./dropship-cost-detection.factory";
import { startDropshipWorkerSchedule } from "./dropship-worker-schedule";

/**
 * .ops cost detection worker (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C2 and
 * C4). Ticks every minute; each tick continues the detection pass under way
 * or starts one when the policy's detection interval has elapsed, processes a
 * bounded number of vendors, and then runs the notice pass over change log
 * rows not yet decided, whichever writer recorded them. Opt-in by
 * environment, advisory-locked so one process runs at a time, scheduled
 * without overlap like every other dropship worker.
 */

interface CostDetectionRunnerService {
  runTick(input: { workerId: string; vendorsPerTick: number }): Promise<DropshipCostDetectionTickResult>;
}

interface CostNoticeRunnerService {
  runNoticePass(input: { workerId: string; groupsPerPass: number }): Promise<DropshipCostNoticePassResult>;
}

const DROPSHIP_COST_DETECTION_LOCK_ID = 736215;
/** The base cadence. The policy's interval (15 minutes to a day) decides when a pass actually starts. */
const DEFAULT_TICK_INTERVAL_MS = 60_000;
/** The tick input contract's ceiling for vendors per tick. */
const MAX_VENDORS_PER_TICK = 1_000;

export async function runDropshipCostDetectionTick(input: {
  service?: CostDetectionRunnerService;
  workerId?: string;
  vendorsPerTick?: number;
} = {}): Promise<DropshipCostDetectionTickResult> {
  const workerId = input.workerId ?? defaultWorkerId();
  const service = input.service ?? createDropshipCostDetectionServiceFromEnv();
  return service.runTick({ workerId, vendorsPerTick: input.vendorsPerTick ?? DEFAULT_COST_DETECTION_VENDORS_PER_TICK });
}

export async function runDropshipCostNoticePass(input: {
  service?: CostNoticeRunnerService;
  workerId?: string;
  groupsPerPass?: number;
} = {}): Promise<DropshipCostNoticePassResult> {
  const workerId = input.workerId ?? defaultWorkerId();
  const service = input.service ?? createDropshipCostChangeNoticeServiceFromEnv();
  return service.runNoticePass({ workerId, groupsPerPass: input.groupsPerPass ?? DEFAULT_COST_NOTICE_GROUPS_PER_PASS });
}

export function startDropshipCostDetectionWorker(): void {
  if (!isDropshipCostDetectionWorkerEnabled()) return;

  const intervalMs = envPositiveInteger("DROPSHIP_COST_DETECTION_TICK_INTERVAL_MS", DEFAULT_TICK_INTERVAL_MS);
  const vendorsPerTick = envBoundedInteger("DROPSHIP_COST_DETECTION_VENDORS_PER_TICK",
    DEFAULT_COST_DETECTION_VENDORS_PER_TICK, MAX_VENDORS_PER_TICK);
  const groupsPerPass = envBoundedInteger("DROPSHIP_COST_NOTICE_GROUPS_PER_TICK",
    DEFAULT_COST_NOTICE_GROUPS_PER_PASS, MAX_COST_NOTICE_GROUPS_PER_PASS);
  const runLockedSweep = async () => {
    try {
      await withAdvisoryLock(DROPSHIP_COST_DETECTION_LOCK_ID, async () => {
        const result = await runDropshipCostDetectionTick({ vendorsPerTick });
        // A tick that found no pass due is the normal quiet case: not logged.
        if (result.outcome !== "not_due") {
          console.info(JSON.stringify({
            code: "DROPSHIP_COST_DETECTION_TICK_COMPLETED",
            message: "Dropship cost detection tick completed.",
            context: result,
          }));
        }
        // Notices go out after detection, and cover changes acceptance recorded too.
        const notices = await runDropshipCostNoticePass({ groupsPerPass });
        if (notices.groupsProcessed > 0 || notices.groupsFailed > 0) {
          console.info(JSON.stringify({
            code: "DROPSHIP_COST_NOTICE_PASS_COMPLETED",
            message: "Dropship cost change notice pass completed.",
            context: notices,
          }));
        }
      });
    } catch (error) {
      console.error(JSON.stringify({
        code: "DROPSHIP_COST_DETECTION_TICK_FAILED",
        message: "Dropship cost detection tick failed.",
        context: buildSchedulerFailureContext(error),
      }));
    }
  };

  const { initialDelayMs } = startDropshipWorkerSchedule({
    name: "costDetection",
    intervalMs,
    run: runLockedSweep,
  });
  console.info(JSON.stringify({
    code: "DROPSHIP_COST_DETECTION_STARTED",
    message: "Dropship cost detection worker started.",
    context: { intervalMs, initialDelayMs, vendorsPerTick, groupsPerPass, schedulingMode: "completion_delayed_non_overlapping" },
  }));
}

function defaultWorkerId(): string {
  return `dropship-cost-detection-${process.pid}`;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** A value above the ceiling would fail the pass's input contract every minute, so it falls back with a warning. */
function envBoundedInteger(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) return fallback;
  if (value > max) {
    console.warn(JSON.stringify({
      code: "DROPSHIP_COST_DETECTION_CONFIG_IGNORED",
      message: "A dropship cost detection batch setting exceeds its ceiling; the default is used.",
      context: { variable: name, value, max, fallback },
    }));
    return fallback;
  }
  return value;
}
