/**
 * The provider's final answer to an uncertain quantity attempt, read from the
 * receipts the owner stored at the time.
 *
 * An attempt is left "uncertain" when the owner could not prove a terminal
 * outcome. Its stored receipts may still show that every request it made got
 * an HTTP answer (nothing is in flight) and that the last answer was a 4xx
 * carrying the provider's own error codes: the provider refused the request
 * and wrote nothing. That answer is offered to the operator so the
 * attestation form is filled from evidence the system already holds. It never
 * resolves an attempt on its own; the stored receipts are immutable and the
 * attestation stays a human act.
 */
import { createHash } from "node:crypto";

export interface StoredProviderRequestReceipt {
  attemptId: string;
  requestId: string;
  ordinal: number;
  method: string;
  path: string;
  startedAt: Date;
  /** Null when the request has no result row: it never got an answer. */
  outcome: "completed" | "rejected" | "uncertain" | null;
  httpStatus: number | null;
  responseHash: string | null;
  errorCodes: string[];
  recordedAt: Date | null;
}

export interface QuantityPublicationProviderAnswer {
  requestId: string;
  method: string;
  path: string;
  httpStatus: number;
  errorCodes: string[];
  responseHash: string;
  recordedAt: string;
}

const FIRST_CLIENT_ERROR_STATUS = 400;
const LAST_CLIENT_ERROR_STATUS = 499;

/**
 * Proof that nothing of an attempt can still reach the provider: every stored
 * activity (the attempt start, each request start, each recorded answer) lies
 * further back than the provider request deadline plus a wide margin. A
 * request that timed out may have been applied, but after this long it cannot
 * still be in flight, so no later write can be overtaken by it; catch-up then
 * republishes the current quantity. The hash pins the exact stored record the
 * operator confirmed.
 */
export interface QuantityPublicationRequestTermination {
  requestCount: number;
  lastActivityAt: string;
  quiescentSince: string;
  providerRequestTimeoutSeconds: number;
  quiescenceMarginMinutes: number;
  evidenceHash: string;
}

/** Far beyond any provider-side processing delay seen; a request cannot stay in flight for an hour. */
export const REQUEST_QUIESCENCE_MARGIN_MS = 60 * 60 * 1000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * 1000;

export function summarizeRequestTermination(input: {
  attemptId: string;
  state: "running" | "uncertain";
  startedAt: Date;
  receipts: readonly StoredProviderRequestReceipt[];
  now: Date;
  providerRequestTimeoutMs: number;
  quiescenceMarginMs?: number;
}): QuantityPublicationRequestTermination | null {
  const marginMs = input.quiescenceMarginMs ?? REQUEST_QUIESCENCE_MARGIN_MS;
  if (!Number.isSafeInteger(input.providerRequestTimeoutMs) || input.providerRequestTimeoutMs <= 0
    || !Number.isSafeInteger(marginMs) || marginMs <= 0) return null;
  const ordered = [...input.receipts].sort((left, right) => left.ordinal - right.ordinal);
  const activity = [input.startedAt.getTime()];
  for (const receipt of ordered) {
    activity.push(receipt.startedAt.getTime());
    if (receipt.recordedAt) activity.push(receipt.recordedAt.getTime());
  }
  const now = input.now.getTime();
  if (!Number.isFinite(now) || activity.some((time) => !Number.isFinite(time))) return null;
  const lastActivity = Math.max(...activity);
  const quiescentSince = lastActivity + input.providerRequestTimeoutMs + marginMs;
  if (now < quiescentSince) return null;
  const record = {
    attemptId: input.attemptId,
    state: input.state,
    startedAt: input.startedAt.toISOString(),
    requests: ordered.map((receipt) => ({
      requestId: receipt.requestId, ordinal: receipt.ordinal, method: receipt.method, path: receipt.path,
      startedAt: receipt.startedAt.toISOString(), outcome: receipt.outcome, httpStatus: receipt.httpStatus,
      responseHash: receipt.responseHash, errorCodes: [...receipt.errorCodes],
      recordedAt: receipt.recordedAt ? receipt.recordedAt.toISOString() : null,
    })),
  };
  return {
    requestCount: ordered.length,
    lastActivityAt: new Date(lastActivity).toISOString(),
    quiescentSince: new Date(quiescentSince).toISOString(),
    providerRequestTimeoutSeconds: Math.ceil(input.providerRequestTimeoutMs / MS_PER_SECOND),
    quiescenceMarginMinutes: Math.ceil(marginMs / MS_PER_MINUTE),
    evidenceHash: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
  };
}

export function summarizeProviderAnswer(
  state: "running" | "uncertain",
  receipts: readonly StoredProviderRequestReceipt[],
): QuantityPublicationProviderAnswer | null {
  // A running attempt may still be sending; only an uncertain one is finished
  // from the owner's side.
  if (state !== "uncertain" || receipts.length === 0) return null;
  const ordered = [...receipts].sort((left, right) => left.ordinal - right.ordinal);
  const unanswered = ordered.some((receipt) =>
    receipt.outcome === null || receipt.httpStatus === null || receipt.responseHash === null || receipt.recordedAt === null);
  if (unanswered) return null;
  const last = ordered[ordered.length - 1];
  // Every earlier request must have completed: an earlier uncertain answer
  // means the last one proves nothing about the attempt as a whole.
  if (ordered.slice(0, -1).some((receipt) => receipt.outcome !== "completed")) return null;
  if (last.outcome === "completed") return null;
  if (last.httpStatus! < FIRST_CLIENT_ERROR_STATUS || last.httpStatus! > LAST_CLIENT_ERROR_STATUS) return null;
  if (last.errorCodes.length === 0) return null;
  return {
    requestId: last.requestId,
    method: last.method,
    path: last.path,
    httpStatus: last.httpStatus!,
    errorCodes: [...last.errorCodes],
    responseHash: last.responseHash!,
    recordedAt: last.recordedAt!.toISOString(),
  };
}
