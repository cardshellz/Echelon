import type { OpeningSource } from "@shared/types/inventory-cutover-opening";
import { openingCaptureStageSchema } from "@shared/types/inventory-opening-capture";

const captureFailureCodes = new Set([
  "CUTOVER_CAPTURE_ARTIFACT_LIMIT", "CUTOVER_EVIDENCE_CAPTURE_TIMEOUT",
  "CUTOVER_EVIDENCE_CAPTURE_CONFLICT", "CUTOVER_EVIDENCE_CAPTURE_LIMIT_EXCEEDED",
  "CUTOVER_EVIDENCE_CAPTURE_INVALID", "CUTOVER_EVIDENCE_CAPTURE_FAILED",
]);

export interface OpeningCaptureWorkerStore {
  claim(): Promise<{ id: string; actor: string } | null>;
  progress(id: string, stage: string): Promise<void>;
  writeResult(id: string, source: OpeningSource): Promise<number>;
  complete(id: string, count: number): Promise<void>;
  fail(id: string, code: string): Promise<void>;
}

/** One snapshot per attempt. Never retry a failed read inside the same job. */
export async function runOpeningCapture(store: OpeningCaptureWorkerStore,
  source: { capture(actor: string, captureId: string): Promise<OpeningSource> },
  log: (entry: Record<string, unknown>) => void): Promise<boolean> {
  const job = await store.claim();
  if (!job) return false;
  try {
    const result = await source.capture(job.actor, job.id);
    await store.progress(job.id, "writing_result");
    const count = await store.writeResult(job.id, result);
    await store.complete(job.id, count);
    log({ event: "inventory_opening_capture_complete", captureId: job.id, chunkCount: count });
  } catch (error) {
    // Only fixed classifications leave this boundary. SQL, row data, credentials
    // and arbitrary exception messages never enter job status or application logs.
    const rawCode = error !== null && typeof error === "object" && "code" in error
      ? error.code : error instanceof Error ? error.message : undefined;
    const code = typeof rawCode === "string" && captureFailureCodes.has(rawCode) ? rawCode : "CUTOVER_CAPTURE_FAILED";
    const stage = openingCaptureStageSchema.safeParse(error !== null && typeof error === "object" && "stage" in error ? error.stage : undefined);
    log({ event: "inventory_opening_capture_failed", captureId: job.id, code, stage: stage.success ? stage.data : "processing" });
    await store.fail(job.id, code);
  }
  return true;
}
