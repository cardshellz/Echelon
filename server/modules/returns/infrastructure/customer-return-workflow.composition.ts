import { randomUUID } from "node:crypto";
import { CustomerReturnWorkflowWorker, type ReturnWorkflowReport } from "../application/customer-return-workflow.worker";
import { PostgresCustomerReturnWorkflowStore } from "./customer-return-workflow.repository";
import { createCustomerReturnLabelServices } from "./customer-return-label.composition";

const SWEEP_INTERVAL_MS = 1_000;
export async function createCustomerReturnWorkflowWorker(report: ReturnWorkflowReport) {
  const [{ pool }, services] = await Promise.all([import("../../../db"), createCustomerReturnLabelServices()]);
  return new CustomerReturnWorkflowWorker({ store: new PostgresCustomerReturnWorkflowStore(pool),
    submissions: services.submissions, labels: services.labels, now: () => new Date(), newToken: randomUUID, report });
}

/** Only explicit persisted workflows are scanned. There is no historical
 * command enrollment and no new rollout switch. The normal scheduler owns it. */
export function startCustomerReturnWorkflowScheduler(worker: Pick<CustomerReturnWorkflowWorker, "run">, report: ReturnWorkflowReport): () => void {
  let running = false, stopped = false;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try { await worker.run(); }
    catch { report({ event: "customer_return_workflow_sweep_failed", code: "RETURN_WORKFLOW_SWEEP_FAILED" }); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void run(); }, SWEEP_INTERVAL_MS);
  timer.unref();
  void run();
  return () => { stopped = true; clearInterval(timer); };
}
