import { z } from "zod";

export class CutoverHttpError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

// These owner errors are emitted only after a command has been rejected or its
// transaction rolled back. A bare/proxy 409 is not proof of rejection. Busy
// conflicts deliberately retain the original key, as instructed by the server.
const definitiveRejectionCodes = new Set([
  "CUTOVER_AUTHORITY_REVISION_CHANGED", "CUTOVER_REVIEW_BLOCKED", "CUTOVER_REVIEW_CHANGED",
  "CUTOVER_TARGET_SET_CHANGED", "CUTOVER_ACTIVATION_STATE_CHANGED", "CUTOVER_PUBLICATION_BLOCKED",
  "CUTOVER_FINAL_PUBLICATION_CHANGED", "CUTOVER_IDEMPOTENCY_CONFLICT", "CUTOVER_FULL_PUBLICATION_NOT_VERIFIED",
  "CUTOVER_VERIFICATION_CHANGED", "CUTOVER_CONFIGURATION_FREEZE_CHANGED", "CUTOVER_COMMITTED_RUN_UNAVAILABLE",
  "CUTOVER_DRY_RUN_BLOCKED", "CUTOVER_SNAPSHOT_COVERAGE_INVALID", "CUTOVER_DEFINITION_MISSING",
  "CUTOVER_DEFINITION_AMBIGUOUS", "CUTOVER_SNAPSHOT_IDENTITY_CHANGED", "CUTOVER_ROOT_MODEL_CHANGED", "CUTOVER_REVIEWED_HEAD_CHANGED",
  "CUTOVER_RECONSTRUCTION_REPLAY_CONFLICT", "CUTOVER_RECONSTRUCTION_EVIDENCE_CHANGED", "CUTOVER_RECONSTRUCTION_BLOCKED", "CUTOVER_FRESH_DEMAND_IMPACT_CHANGED",
  "ACTIVATION_DRY_RUN_NOT_FOUND", "ACTIVATION_DRY_RUN_NOT_READY", "ACTIVATION_PUBLICATION_TARGET_CHANGED", "ACTIVATION_TRANSFORMATION_MODEL_CHANGED",
  "ACTIVATION_SOURCE_BINDING_CHANGED", "ACTIVATION_VARIANT_MAPPING_CHANGED", "ACTIVATION_CHANNEL_POLICY_CHANGED",
  "ACTIVATION_LOCATION_POLICY_CHANGED", "ACTIVATION_SAFETY_POLICY_CHANGED", "ACTIVATION_SHADOW_EVIDENCE_MISSING", "ACTIVATION_SELECTION_AMBIGUOUS",
  "PUBLICATION_RECOVERY_REPLAY_CONFLICT", "PUBLICATION_RECOVERY_STATE_INVALID",
]);

export function isDefinitiveCutoverRejection(error: unknown): boolean {
  return error instanceof CutoverHttpError && error.status === 409
    && error.code !== undefined && definitiveRejectionCodes.has(error.code);
}

/** Explicit administrative commands only. A response is never trusted merely
 * because HTTP succeeded; uncertainty retains the caller's original retry key. */
export async function postInventoryPlanningCommand<T>(
  namespace: "cutover" | "publication-recovery", action: string, body: unknown,
  schema: z.ZodType<T>, signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/inventory-planning/admin/${namespace}/${action}`, {
    method: "POST", credentials: "include", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new CutoverHttpError("The server response could not be verified. Check run status before retrying the same command.", response.status); }
  if (!response.ok) {
    const failure = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(payload);
    throw new CutoverHttpError(failure.success ? failure.data.error.message : `Cutover request failed (HTTP ${response.status}).`, response.status,
      failure.success ? failure.data.error.code : undefined);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new CutoverHttpError("The server response failed validation. No successful change is being reported; check the current run.", 500);
  return parsed.data;
}

export function postCutoverCommand<T>(action: string, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
  return postInventoryPlanningCommand("cutover", action, body, schema, signal);
}
