import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const quantityProviderResponseEvidenceSchema = z.object({
  outcome: z.enum(["completed", "rejected", "uncertain"]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  providerRequestId: z.string().regex(/^[\x21-\x7e]{1,200}$/).nullable(),
  responseHash: sha256.nullable(),
  errorCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)).max(25),
  retryNotBefore: z.string().datetime().nullable(),
  cooldownScope: z.enum(["item","account"]).nullable(),
}).strict().superRefine((value,context) => {
  if ((value.retryNotBefore === null) !== (value.cooldownScope === null)) context.addIssue({
    code: z.ZodIssueCode.custom,message: "A retry deadline and its cooldown scope must be supplied together.",
  });
  if (value.outcome === "rejected" && (value.httpStatus === null || value.responseHash === null)) context.addIssue({
    code: z.ZodIssueCode.custom,message: "Terminal rejection requires a completed HTTP response record.",
  });
});
export type QuantityProviderResponseEvidence = z.infer<typeof quantityProviderResponseEvidenceSchema>;
export interface QuantityProviderRequestStart {
  ordinal: number; method: string; path: string; requestHash: string; startedAt: string;
}
export interface QuantityProviderRequestEvidenceStore {
  start(request: QuantityProviderRequestStart): Promise<string>;
  finish(requestId: string, evidence: QuantityProviderResponseEvidence, recordedAt: string): Promise<void>;
}

export class QuantityProviderRejectionError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "QuantityProviderRejectionError"; }
}
export class QuantityProviderEvidenceError extends Error {
  readonly code = "PUBLICATION_REQUEST_EVIDENCE_INCOMPLETE";
  constructor() { super("A quantity request has incomplete or uncertain terminal evidence; reconciliation is required."); }
}

interface RequestObservation { response: QuantityProviderResponseEvidence | null }
const currentRequest = new AsyncLocalStorage<RequestObservation>();
const currentOwner = new AsyncLocalStorage<QuantityProviderEvidenceCollector>();
// Accommodates the bounded 250-member listing protocol plus lifecycle requests.
const MAX_PROVIDER_REQUESTS_PER_OWNER = 2000;
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Transport metadata only: never headers containing credentials or raw provider bodies. */
export function recordQuantityProviderResponse(evidence: QuantityProviderResponseEvidence): void {
  const observation = currentRequest.getStore();
  if (!observation) return;
  if (observation.response) throw new QuantityProviderEvidenceError();
  observation.response = quantityProviderResponseEvidenceSchema.parse(evidence);
}

/** Explicitly stateful, scoped to one admitted owner; historical attempts are never inferred or repaired. */
export class QuantityProviderEvidenceCollector {
  private ordinal = 0;
  private pending = 0;
  private uncertain = false;
  private sealed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly recorded: Array<{ requestId: string; evidence: QuantityProviderResponseEvidence }> = [];
  private readonly rejectedErrors = new Set<unknown>();
  constructor(private readonly store: QuantityProviderRequestEvidenceStore, private readonly clock: () => Date) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    try { return await currentOwner.run(this, work); }
    finally { this.sealed = true; await this.tail; }
  }
  assertNoAmbiguousRequests(): void {
    if (this.uncertain || this.pending > 0) throw new QuantityProviderEvidenceError();
    // A caller may catch an adapter error. It still cannot acknowledge success.
    if (this.rejectedErrors.size > 0) throw this.rejectedErrors.values().next().value;
  }
  provesTerminalRejection(): boolean {
    return this.rejectedErrors.size > 0
      && !this.uncertain && this.pending === 0 && this.recorded.length > 0
      && this.recorded.every(row => row.evidence.httpStatus !== null && row.evidence.responseHash !== null);
  }
  evidenceHash(): string { return digest(this.recorded); }

  observe<T>(request: { method: string; path: string; body?: unknown }, work: () => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new QuantityProviderEvidenceError());
    // One owner holds one connection. Serialize evidence transactions AND HTTP;
    // drain queued work before releasing its session locks, even on callback failure.
    const operation = this.tail.then(() => this.perform(request, work));
    this.tail = operation.then(() => undefined, () => {
      if (this.rejectedErrors.size === 0) this.uncertain = true;
    });
    return operation;
  }

  private async perform<T>(request: { method: string; path: string; body?: unknown }, work: () => Promise<T>): Promise<T> {
    if (this.uncertain || this.rejectedErrors.size > 0 || this.ordinal >= MAX_PROVIDER_REQUESTS_PER_OWNER) throw new QuantityProviderEvidenceError();
    if (!/^(POST|PUT|DELETE)$/.test(request.method) || !/^\/sell\/inventory\/v1\/[^\s?#]{1,1000}$/.test(request.path)) {
      throw new QuantityProviderEvidenceError();
    }
    this.pending += 1;
    try {
      const requestId = await this.store.start({ ordinal: ++this.ordinal, method: request.method,
        path: request.path, requestHash: digest(request.body ?? null), startedAt: this.clock().toISOString() });
      const observation: RequestObservation = { response: null };
      let value!: T; let failure: unknown; let failed = false;
      try { value = await currentRequest.run(observation, work); }
      catch (error) { failed = true; failure = error; }
      const response = observation.response;
      // A generic callback completion is not relabeled as an HTTP receipt. Uninstrumented
      // transports retain their existing completion contract; errors remain uncertain.
      const evidence = quantityProviderResponseEvidenceSchema.parse(response ?? {
        outcome: failed ? "uncertain" : "completed", httpStatus: null, providerRequestId: null,
        responseHash: null, errorCodes: [], retryNotBefore: null, cooldownScope: null,
      });
      if (failed && evidence.outcome !== "rejected") {
        evidence.outcome = "uncertain";
      }
      if (evidence.outcome === "uncertain") this.uncertain = true;
      await this.store.finish(requestId, evidence, this.clock().toISOString());
      this.recorded.push({ requestId, evidence });
      if (failed) {
        if (evidence.outcome === "rejected") this.rejectedErrors.add(failure);
        throw failure;
      }
      return value;
    } catch (error) {
      if (!this.rejectedErrors.has(error)) this.uncertain = true;
      throw error;
    } finally { this.pending -= 1; }
  }
}

/** Shared eBay protocol boundary covers routed, maintenance, Dropship and group writes. */
export function observeEbayQuantityRequest<T>(request: { method: string; path: string; body?: unknown }, work: () => Promise<T>): Promise<T> {
  const owner = currentOwner.getStore();
  return owner && request.method !== "GET" ? owner.observe(request, work) : work();
}
