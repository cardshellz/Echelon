import { randomUUID } from "node:crypto";
import { z } from "zod";
import { startNonOverlappingScheduler, type NonOverlappingSchedulerHandle } from "../../infrastructure/non-overlapping-scheduler";
import { schedulerIsDisabled } from "../../infrastructure/scheduler-config";
import {
  assertRecoveryDate, receiptCostRecoveryOutcome, recoveryRetryOutcome, type ReceiptCostRecoveryOutcome,
  RECEIPT_COST_RECOVERY_GRACE_MS, RECEIPT_COST_RECOVERY_LEASE_MS, RECEIPT_COST_RECOVERY_MAX_ATTEMPTS,
} from "./receipt-cost-recovery.domain";
import type { ReceiptCostRecoveryRepository } from "./receipt-cost-recovery.repository";

export interface ReceiptCostRecoveryDependencies {
  repository: ReceiptCostRecoveryRepository;
  receiving: { retryCostsAutomatically(receiptId: number, requestId: number): Promise<unknown> };
  clock: () => Date;
  leaseToken: () => string;
  logger: { info(value: unknown): void; error(value: unknown): void };
}

export async function runReceiptCostRecoveryBatch(dependencies: ReceiptCostRecoveryDependencies, batchSize = 5) {
  z.number().int().min(1).max(25).parse(batchSize);
  const initial = dependencies.clock(); assertRecoveryDate(initial);
  await dependencies.repository.prepare({ now: initial, maxAttempts: RECEIPT_COST_RECOVERY_MAX_ATTEMPTS,
    graceMs: RECEIPT_COST_RECOVERY_GRACE_MS, limit: batchSize * 2 });
  const result = { claimed: 0, applied: 0, reviewRequired: 0, retried: 0, exhausted: 0, leaseLost: 0 };
  // Claim just before processing so slow cost transactions do not consume the
  // leases of the rest of a batch. Financial owners serialize graph updates.
  for (let index = 0; index < batchSize; index++) {
    const claim = await dependencies.repository.claimNext({ now: dependencies.clock(), leaseMs: RECEIPT_COST_RECOVERY_LEASE_MS,
      leaseToken: dependencies.leaseToken() });
    if (!claim) break;
    result.claimed++;
    let outcome: ReceiptCostRecoveryOutcome;
    try {
      const value = await dependencies.receiving.retryCostsAutomatically(claim.receiptId, claim.requestId);
      outcome = receiptCostRecoveryOutcome(claim, value, dependencies.clock());
    } catch (error) {
      dependencies.logger.error({ code: "RECEIPT_COST_RECOVERY_PROCESSING_FAILED", requestId: claim.requestId,
        receiptId: claim.receiptId, error: error instanceof Error ? error.name : "UnknownError" });
      outcome = recoveryRetryOutcome(claim, "RECEIPT_COST_RECOVERY_PROCESSING_FAILED", dependencies.clock());
    }
    const completed = await dependencies.repository.complete(claim, outcome, dependencies.clock());
    if (!completed) {
      result.leaseLost++;
      dependencies.logger.error({ code: "RECEIPT_COST_RECOVERY_LEASE_LOST", requestId: claim.requestId, receiptId: claim.receiptId });
    } else if (completed === "applied") result.applied++;
    else if (completed === "review_required") result.reviewRequired++;
    else if (completed === "exhausted") result.exhausted++;
    else result.retried++;
  }
  if (result.claimed > 0) dependencies.logger.info({ code: "RECEIPT_COST_RECOVERY_BATCH_COMPLETED", ...result });
  return result;
}

/** Production composition injects wall time and lease entropy here. Disabled
 * until explicitly enabled; global scheduler shutdown remains authoritative. */
export function startReceiptCostRecoveryWorker(
  dependencies: Pick<ReceiptCostRecoveryDependencies, "repository" | "receiving">,
  environment: NodeJS.ProcessEnv = process.env,
): NonOverlappingSchedulerHandle | null {
  if (schedulerIsDisabled("RECEIPT_COST_RECOVERY_DISABLED", environment) || environment.RECEIPT_COST_RECOVERY_ENABLED !== "true") return null;
  return startNonOverlappingScheduler({ taskName: "receipt-cost-recovery", initialDelayMs: 30_000, intervalMs: 60_000,
    logger: { error: (payload) => console.error(JSON.stringify(payload)) },
    run: async () => { await runReceiptCostRecoveryBatch({ ...dependencies, clock: () => new Date(), leaseToken: randomUUID,
      logger: { info: (payload) => console.info(JSON.stringify(payload)), error: (payload) => console.error(JSON.stringify(payload)) } }); } });
}
