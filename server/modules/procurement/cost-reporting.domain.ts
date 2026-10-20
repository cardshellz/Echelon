import { costInventoryEffectProofSchema, type CostSourceRevision } from "@shared/procurement/cost-source-contracts";
import { proveNoInventoryEffect } from "../inventory/domain/no-inventory-effect";
import { schedulerIsDisabled } from "../../infrastructure/scheduler-config";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { COST_REPORT_MAX_BYTES, costReportAcknowledgementSchema, costReportEnvelopeCoreSchema, costReportEnvelopeSchema, inventoryCostReportEventSchema, type CostReportAcknowledgement, type CostReportEnvelope, type InventoryCostReportEvent } from "@shared/procurement/cost-report-delivery";

export const COST_REPORT_MAX_ATTEMPTS = 8;
export const COST_REPORT_LEASE_MS = 60_000;
export const COST_REPORT_TIMEOUT_MS = 15_000;
export const COST_REPORT_BATCH_SIZE = 10;
export class CostReportingError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly statusCode = 409) { super(message); this.name = "CostReportingError"; }
}
export const reportHash = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");

export const reportDestinationSchema = z.object({
  id: z.string().uuid(), sourceSystemId: costReportEnvelopeCoreSchema.shape.sourceSystemId,
  endpoint: z.string().url().max(2048), enabled: z.boolean(),
}).strict();
export type ReportDestination = z.infer<typeof reportDestinationSchema>;
export type ReportTransportConfiguration = ReportDestination & { token: string };

export function parseReportConfiguration(env: Record<string, string | undefined>): ReportTransportConfiguration | null {
  if (!env.COST_REPORT_DESTINATION_ID && !env.ARCHON_COST_REPORT_URL && !env.ECHELON_COST_REPORT_SOURCE_ID && !env.ARCHON_COST_REPORT_TOKEN) return null;
  const value = reportDestinationSchema.parse({ id: env.COST_REPORT_DESTINATION_ID, sourceSystemId: env.ECHELON_COST_REPORT_SOURCE_ID,
    endpoint: env.ARCHON_COST_REPORT_URL, enabled: env.COST_REPORT_DELIVERY_ENABLED === "true" && !schedulerIsDisabled("COST_REPORT_DELIVERY_DISABLED",env) });
  const url = new URL(value.endpoint);
  const allowedHosts = (env.COST_REPORT_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port !== "" && url.port !== "443")
    || !allowedHosts.includes(url.hostname.toLowerCase()) || !/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes(".")) {
    throw new CostReportingError("COST_REPORT_DESTINATION_INVALID", "Reporting requires an explicitly allowed HTTPS destination without credentials, query, fragment or a nonstandard port.", false, 503);
  }
  const token = env.ARCHON_COST_REPORT_TOKEN;
  if (!token || token.length < 32 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) throw new CostReportingError("COST_REPORT_AUTH_NOT_CONFIGURED", "The reporting credential is missing or invalid.", false, 503);
  return { ...value, endpoint: url.toString(), token };
}

export function buildCostReportEnvelope(input: {
  destination: ReportDestination; deliveryId: string; sourceEventId: string; applicationId: string;
  purchaseOrderId: number; purchaseOrderLineId: number; payload: unknown;
}): CostReportEnvelope {
  const payload = inventoryCostReportEventSchema.parse(input.payload);
  if (payload.inventoryEffectProof && payload.inventoryEffectProof.purchaseOrderLineId !== input.purchaseOrderLineId) {
    throw new CostReportingError("COST_REPORT_SOURCE_CONFLICT", "The no-inventory-effect proof belongs to another purchase order line.");
  }
  const core = costReportEnvelopeCoreSchema.parse({ contractVersion: 1, eventType: "inventory.cost_application_recorded",
    sourceSystemId: input.destination.sourceSystemId, destinationId: input.destination.id, deliveryId: input.deliveryId,
    sourceEventId: input.sourceEventId, applicationId: input.applicationId, purchaseOrderId: input.purchaseOrderId,
    purchaseOrderLineId: input.purchaseOrderLineId, payloadHash: reportHash(payload), payload });
  const envelope = costReportEnvelopeSchema.parse({ ...core, reportHash: reportHash(core) });
  if (Buffer.byteLength(canonicalJson(envelope), "utf8") > COST_REPORT_MAX_BYTES) throw new CostReportingError("COST_REPORT_TOO_LARGE", "The source event exceeds the supported report size; it has not been truncated.");
  return envelope;
}

const noInventoryEffectApplicationSchema = z.object({
  inventoryEffectProof: costInventoryEffectProofSchema,
  noInventoryEffectEvidence: z.unknown(),
});
const noInventoryEffectOutcomeSchema = z.object({
  status: z.literal("applied"),
  lotsUpdated: z.literal(0),
  cogsRowsUpdated: z.literal(0),
  totalCogsDeltaCents: z.literal(0),
  issues: z.array(z.unknown()).length(0),
  inventoryEffectProof: costInventoryEffectProofSchema,
});

/** Delivery preserves the inventory owner's immutable proof. A missing field
 * cannot turn a no-effect application into an ordinary empty adjustment. */
export function costReportInventoryEffectMatches(input: {
  source: CostSourceRevision;
  payload: InventoryCostReportEvent;
  applicationStatus: unknown;
  applicationOutcome: unknown;
  applicationEvidence: unknown;
  actualLotCount: number;
  historicalPostingCount: number;
  hasReconciliation: boolean;
}): boolean {
  const applicationHasProof = input.applicationOutcome !== null
    && typeof input.applicationOutcome === "object"
    && "inventoryEffectProof" in input.applicationOutcome;
  const applicationHasEvidence = input.applicationEvidence !== null
    && typeof input.applicationEvidence === "object"
    && ("inventoryEffectProof" in input.applicationEvidence || "noInventoryEffectEvidence" in input.applicationEvidence);
  const effect = input.source.inventoryEffect;
  const proof = input.payload.inventoryEffectProof;
  if (effect === undefined && proof === undefined && !applicationHasProof && !applicationHasEvidence) return true;

  const outcome = noInventoryEffectOutcomeSchema.safeParse(input.applicationOutcome);
  const application = noInventoryEffectApplicationSchema.safeParse(input.applicationEvidence);
  if (effect === undefined || proof === undefined || !outcome.success || !application.success
    || input.applicationStatus !== "applied" || input.actualLotCount !== 0
    || input.historicalPostingCount !== 0 || input.hasReconciliation
    || input.payload.changes.length !== 0 || input.payload.cogsDeltaCents !== 0
    || input.payload.historicalCostAdjustments !== undefined || input.payload.unresolvedQuantities !== undefined) return false;

  // Re-prove the retained snapshot, not today's mutable custody. Reporting an
  // immutable past outcome must not silently replace it with current evidence.
  const retained = proveNoInventoryEffect(input.source, application.data.noInventoryEffectEvidence);
  return retained.proof !== null
    && proof.purchaseOrderLineId === input.source.scope.purchaseOrderLineId
    && reportHash(proof.inventoryEffect) === reportHash(effect)
    && reportHash(proof) === reportHash(outcome.data.inventoryEffectProof)
    && reportHash(proof) === reportHash(application.data.inventoryEffectProof)
    && reportHash(proof) === reportHash(retained.proof);
}

export function verifyReportAcknowledgement(raw: unknown, envelope: CostReportEnvelope): CostReportAcknowledgement {
  const parsed = costReportAcknowledgementSchema.safeParse(raw);
  if (!parsed.success || (["sourceSystemId", "destinationId", "deliveryId", "sourceEventId", "payloadHash", "reportHash"] as const)
    .some((key) => parsed.data[key] !== envelope[key])) {
    throw new CostReportingError("COST_REPORT_ACK_INVALID", "The receiver acknowledgement does not match this exact destination and report.");
  }
  return parsed.data;
}

export function reportFailure(error: unknown): CostReportingError {
  return error instanceof CostReportingError ? error : new CostReportingError("COST_REPORT_DELIVERY_UNAVAILABLE", "Report delivery failed; the retained event can be retried.", true, 503);
}
export function nextReportFailure(attempt: number, error: CostReportingError, now: Date): { state: "retry_required" | "dead_letter"; nextAttemptAt: Date | null } {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isFinite(now.getTime())) throw new TypeError("Invalid report attempt or clock");
  const retry = error.retryable && attempt < COST_REPORT_MAX_ATTEMPTS;
  return { state: retry ? "retry_required" : "dead_letter", nextAttemptAt: retry ? new Date(now.getTime() + Math.min(3_600_000, 30_000 * 2 ** Math.min(attempt - 1, 10))) : null };
}
