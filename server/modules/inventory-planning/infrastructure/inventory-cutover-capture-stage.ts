import { z, ZodError } from "zod";

const captureStageSchema = z.enum([
  "transaction_guard", "inventory_custody", "wms_demand_and_packages", "variant_identity",
  "original_costs", "oms_demand_and_receipts", "shipment_reviews", "evidence_validation",
]);
export type InventoryCutoverCaptureStage = z.infer<typeof captureStageSchema>;

const stageLabels: Record<InventoryCutoverCaptureStage, string> = {
  transaction_guard: "the protected database snapshot",
  inventory_custody: "inventory balances and ownership history",
  wms_demand_and_packages: "warehouse orders and package contents",
  variant_identity: "catalog item identities",
  original_costs: "original picked-item costs",
  oms_demand_and_receipts: "sales-channel demand and shipment acknowledgments",
  shipment_reviews: "shipment review evidence",
  evidence_validation: "the complete evidence contract",
};

const censusLimitCodes = new Set([
  "INVENTORY_CUTOVER_CAPTURE_LIMIT_EXCEEDED",
  "INVENTORY_CUTOVER_RECONSTRUCTION_CENSUS_LIMIT_EXCEEDED",
  "CUTOVER_JOURNAL_ROW_LIMIT_EXCEEDED",
  "CUTOVER_JOURNAL_GROUP_LIMIT_EXCEEDED",
  "WMS_CUTOVER_RECONSTRUCTION_CENSUS_LIMIT_EXCEEDED",
  "WMS_CUTOVER_REVIEW_CENSUS_LIMIT_EXCEEDED",
  "CUTOVER_ORIGINAL_COST_CENSUS_LIMIT_EXCEEDED",
  "CUTOVER_VARIANT_CENSUS_LIMIT_EXCEEDED",
  "OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED",
]);

type FailureKind = "TIMEOUT" | "CONFLICT" | "LIMIT_EXCEEDED" | "INVALID" | "FAILED";

/** Carries only a named capture stage and sanitized classification. The original
 * cause is retained for internal debugging, never included in the HTTP payload. */
export class InventoryCutoverCaptureError extends Error {
  readonly stage: InventoryCutoverCaptureStage;
  readonly code: string;
  readonly status: number;
  readonly postgresCode: string | null;

  constructor(stage: InventoryCutoverCaptureStage, cause: unknown) {
    const validStage = captureStageSchema.parse(stage);
    const rawCode = cause !== null && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    const postgresCode = typeof rawCode === "string" && /^[A-Z0-9]{5}$/.test(rawCode) ? rawCode : null;
    // Some existing owner readers predate typed errors. Accept only their exact
    // fixed limit messages, not arbitrary exception text or code prefixes.
    const limit = (typeof rawCode === "string" && censusLimitCodes.has(rawCode))
      || (cause instanceof Error && censusLimitCodes.has(cause.message));
    const kind: FailureKind = postgresCode === "57014" ? "TIMEOUT"
      : ["40001", "40P01", "55P03"].includes(postgresCode ?? "") ? "CONFLICT"
      : limit ? "LIMIT_EXCEEDED" : cause instanceof ZodError ? "INVALID" : "FAILED";
    const messages: Record<FailureKind, string> = {
      TIMEOUT: "The database canceled the evidence read before it completed.",
      CONFLICT: "A concurrent database operation prevented a complete evidence read.",
      LIMIT_EXCEEDED: "The evidence exceeds the supported complete-census limit.",
      INVALID: "The captured evidence failed validation.",
      FAILED: "The evidence read failed.",
    };
    super(`Could not finish reading ${stageLabels[validStage]}. ${messages[kind]} No complete review is available; check the run status before retrying.`, { cause });
    this.name = "InventoryCutoverCaptureError";
    this.stage = validStage;
    this.code = `CUTOVER_EVIDENCE_CAPTURE_${kind}`;
    this.status = kind === "TIMEOUT" ? 503 : kind === "CONFLICT" ? 409 : kind === "LIMIT_EXCEEDED" ? 422 : 500;
    this.postgresCode = postgresCode;
  }
}

/** No retry, partial result, timeout increase or transaction mutation. */
export async function captureInventoryCutoverStage<T>(stage: InventoryCutoverCaptureStage, work: () => Promise<T>): Promise<T> {
  captureStageSchema.parse(stage);
  try { return await work(); }
  catch (cause) {
    if (cause instanceof InventoryCutoverCaptureError) throw cause;
    throw new InventoryCutoverCaptureError(stage, cause);
  }
}
