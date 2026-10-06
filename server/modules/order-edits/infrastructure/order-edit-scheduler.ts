import type { OrderEditService } from "../application/order-edit.service";

export const ORDER_EDIT_SWEEP_INTERVAL_MS = 30_000;

/** Persisted deadlines survive restarts; disabled settings only block new edits. */
export function startOrderEditScheduler(
  service: Pick<OrderEditService, "sweep">,
  report: (event: { code: string }) => void,
): () => void {
  let running = false;
  const sweep = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await service.sweep();
    } catch {
      report({ code: "ORDER_EDIT_SWEEP_FAILED" });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void sweep();
  }, ORDER_EDIT_SWEEP_INTERVAL_MS);
  timer.unref();
  void sweep();
  return () => clearInterval(timer);
}
