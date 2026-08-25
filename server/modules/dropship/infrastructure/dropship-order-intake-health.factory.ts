import {
  DropshipOrderIntakeHealthService,
  makeDropshipOrderIntakeHealthLogger,
  systemDropshipOrderIntakeHealthClock,
} from "../application/dropship-order-intake-health-service";
import type { DropshipOrderIntakeHealthPolicy } from "../domain/dropship-order-intake-health";
import { createDropshipNotificationServiceFromEnv } from "./dropship-notification.factory";
import { PgDropshipOrderIntakeHealthRepository } from "./dropship-order-intake-health.repository";

const DEFAULT_DEGRADED_AFTER_FAILURES = 2;
const DEFAULT_STOPPED_AFTER_FAILURES = 6;
const DEFAULT_DEGRADED_AFTER_MINUTES = 15;
const DEFAULT_STOPPED_AFTER_MINUTES = 30;

export function createDropshipOrderIntakeHealthServiceFromEnv(): DropshipOrderIntakeHealthService {
  return new DropshipOrderIntakeHealthService({
    repository: new PgDropshipOrderIntakeHealthRepository(),
    notificationSender: createDropshipNotificationServiceFromEnv(),
    clock: systemDropshipOrderIntakeHealthClock,
    logger: makeDropshipOrderIntakeHealthLogger(),
    policy: dropshipOrderIntakeHealthPolicyFromEnv(process.env),
  });
}

export function dropshipOrderIntakeHealthPolicyFromEnv(
  env: NodeJS.ProcessEnv,
): DropshipOrderIntakeHealthPolicy {
  const degradedAfterFailures = positiveInteger(
    env.DROPSHIP_ORDER_INTAKE_DEGRADED_AFTER_FAILURES,
    DEFAULT_DEGRADED_AFTER_FAILURES,
  );
  const stoppedAfterFailures = positiveInteger(
    env.DROPSHIP_ORDER_INTAKE_STOPPED_AFTER_FAILURES,
    DEFAULT_STOPPED_AFTER_FAILURES,
  );
  const degradedAfterMinutes = positiveInteger(
    env.DROPSHIP_ORDER_INTAKE_DEGRADED_AFTER_MINUTES,
    DEFAULT_DEGRADED_AFTER_MINUTES,
  );
  const stoppedAfterMinutes = positiveInteger(
    env.DROPSHIP_ORDER_INTAKE_STOPPED_AFTER_MINUTES,
    DEFAULT_STOPPED_AFTER_MINUTES,
  );
  if (stoppedAfterFailures <= degradedAfterFailures) {
    throw new Error("DROPSHIP_ORDER_INTAKE_STOPPED_AFTER_FAILURES must exceed the degraded threshold.");
  }
  if (stoppedAfterMinutes <= degradedAfterMinutes) {
    throw new Error("DROPSHIP_ORDER_INTAKE_STOPPED_AFTER_MINUTES must exceed the degraded threshold.");
  }
  return {
    degradedAfterFailures,
    stoppedAfterFailures,
    degradedAfterMs: degradedAfterMinutes * 60_000,
    stoppedAfterMs: stoppedAfterMinutes * 60_000,
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer environment value: ${value}`);
  }
  return parsed;
}
