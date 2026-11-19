import { describe, expect, it } from "vitest";
import { DatabaseError } from "pg";
import { ZodError } from "zod";
import {
  STOCK_LINK_BUSY_CODES,
  STOCK_LINK_FATAL_CODES,
  STOCK_LINK_PAUSE_CODES,
  STOCK_LINK_PERMANENT_CODES,
  STOCK_LINK_TRANSIENT_CODES,
  StockLinkError,
  classifyStockLinkFailure,
  stockLinkCodeKind,
  type StockLinkFailureKind,
  type StockLinkFailureScope,
} from "../../domain/stock-link-errors";
import { STOCK_LINK_DECISION_CODES } from "../../domain/stock-link";
import { InventoryPublicationMembershipError } from "../../application/inventory-publication-membership.service";
import { InventoryAvailabilityRuntimePublicationError } from "../../application/inventory-availability-runtime-publication.service";
import { InventoryAvailabilityMasterDataError } from "../../domain/inventory-availability-master-data.contracts";
import { InventoryCutoverManifestError } from "../../domain/inventory-cutover-manifest";
import { InventoryCutoverAdmissionFenceError } from "../../infrastructure/inventory-cutover-admission-fence.repository";

// Channels PR2 (PLAN-CH2 v4.1 §4.6, §10, §11.1; TST-2, SAF-4, SAF-9): one case per code the engine's dependencies
// actually throw — the cutover fence (migrations/236_inventory_cutover_admission.sql:89-105 and its wrapper), the
// mapping store and applyMappingPreparation (publication-mapping-preparation.repository.ts), the sealer
// (inventory-cutover-definitions.repository.ts), the draft writer (inventory-channel-exposure-admin.repository.ts),
// the enqueue's TRY lock (inventory-availability-runtime-publication.repository.ts), the adapter and the engine
// itself — plus SQLSTATEs, lost connections and unknown errors. Unknown is fatal for the destination, never a
// silently permanent row (DV4-13).

const pgError = (code: string, message = `pg ${code}`): DatabaseError => {
  const error = new DatabaseError(message, 0, "error");
  error.code = code;
  return error;
};
const membership = (code: string) => new InventoryPublicationMembershipError(code, `store ${code}`);
const masterData = (code: string) => new InventoryAvailabilityMasterDataError(409, code, `draft writer ${code}`);
const withCode = (code: string, message = code) => Object.assign(new Error(message), { code });

interface Case {
  readonly source: string;
  readonly error: unknown;
  readonly kind: StockLinkFailureKind;
  readonly code: string;
  readonly scope: StockLinkFailureScope;
  readonly causeCode?: string | null;
}

const cases: Case[] = [
  // Cutover fence: acquire_cutover_admission_fence (236:89-105) and the trigger's frozen refusal; NOWAIT → 55P03.
  { source: "fence", error: pgError("55000", "CUTOVER_CONFIGURATION_FREEZE_CHANGED"), kind: "busy", code: "CUTOVER_CONFIGURATION_FREEZE_CHANGED", scope: "row", causeCode: "55000" },
  { source: "fence trigger", error: pgError("55000", "CUTOVER_CONFIGURATION_FROZEN"), kind: "busy", code: "CUTOVER_CONFIGURATION_FROZEN", scope: "row", causeCode: "55000" },
  { source: "fence", error: pgError("55000", "CUTOVER_AUTHORITY_CHANGED"), kind: "transient", code: "CUTOVER_AUTHORITY_CHANGED", scope: "row", causeCode: "55000" },
  { source: "fence", error: pgError("55000", "CUTOVER_AUTHORITY_INVALID"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "55000" },
  { source: "fence", error: pgError("55000", "CUTOVER_ADMISSION_SINGLETON_MISSING"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "55000" },
  { source: "fence NOWAIT", error: pgError("55P03"), kind: "busy", code: "STOCK_LINK_DATABASE_BUSY", scope: "row", causeCode: "55P03" },
  { source: "fence wrapper", error: new InventoryCutoverAdmissionFenceError("INVENTORY_CUTOVER_FENCE_INPUT_INVALID", "x"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "INVENTORY_CUTOVER_FENCE_INPUT_INVALID" },
  { source: "fence wrapper", error: new InventoryCutoverAdmissionFenceError("INVENTORY_CUTOVER_FENCE_RECEIPT_INVALID", "x"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "INVENTORY_CUTOVER_FENCE_RECEIPT_INVALID" },
  // Mapping store (P-6) and applyMappingPreparation.
  { source: "store", error: membership("STOCK_MAPPING_CONCURRENT_CHANGE"), kind: "busy", code: "STOCK_MAPPING_CONCURRENT_CHANGE", scope: "row" },
  { source: "store", error: membership("STOCK_MAPPING_CLEANUP_UNCERTAIN"), kind: "cleanup_uncertain", code: "STOCK_MAPPING_CLEANUP_UNCERTAIN", scope: "row" },
  { source: "store", error: new AggregateError([new Error("work"), new Error("rollback")], "Mapping preparation and rollback failed."), kind: "fatal", code: "STOCK_LINK_ROLLBACK_FAILED", scope: "destination", causeCode: "AggregateError" },
  { source: "review", error: membership("STOCK_LISTING_TARGET_MISMATCH"), kind: "fatal", code: "STOCK_LISTING_TARGET_MISMATCH", scope: "destination" },
  { source: "apply", error: membership("STOCK_MAPPING_COMMAND_CONFLICT"), kind: "permanent", code: "STOCK_MAPPING_COMMAND_CONFLICT", scope: "row" },
  { source: "apply", error: membership("STOCK_MAPPING_REVIEW_STALE"), kind: "transient", code: "STOCK_MAPPING_REVIEW_STALE", scope: "row" },
  { source: "apply", error: membership("STOCK_MAPPING_NOT_READY"), kind: "transient", code: "STOCK_MAPPING_NOT_READY", scope: "row" },
  { source: "apply", error: membership("STOCK_MAPPING_PROVIDER_BUSY"), kind: "busy", code: "STOCK_MAPPING_PROVIDER_BUSY", scope: "row" },
  { source: "apply", error: membership("STOCK_MAPPING_AUTHORITY_CHANGED"), kind: "transient", code: "STOCK_MAPPING_AUTHORITY_CHANGED", scope: "row" },
  { source: "review blocker", error: withCode("STOCK_MAPPING_TARGET_CHANGED"), kind: "transient", code: "STOCK_MAPPING_TARGET_CHANGED", scope: "row" },
  { source: "review blocker", error: withCode("CANONICAL_AUTHORITY_REQUIRED"), kind: "transient", code: "CANONICAL_AUTHORITY_REQUIRED", scope: "row" },
  // Sealer (P-4).
  { source: "sealer", error: new InventoryCutoverManifestError("CUTOVER_REVIEWED_HEAD_CHANGED", "x"), kind: "transient", code: "CUTOVER_REVIEWED_HEAD_CHANGED", scope: "row" },
  { source: "sealer", error: new InventoryCutoverManifestError("CUTOVER_AUDIT_INVALID", "x"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "CUTOVER_AUDIT_INVALID" },
  // Draft writer (P-3): races re-decide next tick; its own idempotency conflict is a command conflict.
  { source: "draft writer", error: masterData("INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT"), kind: "transient", code: "INVENTORY_PUBLICATION_VARIANT_MAPPING_IDENTITY_CONFLICT", scope: "row" },
  { source: "draft writer", error: masterData("INVENTORY_PUBLICATION_VARIANT_MAPPING_SCOPE_INVALID"), kind: "transient", code: "INVENTORY_PUBLICATION_VARIANT_MAPPING_SCOPE_INVALID", scope: "row" },
  { source: "draft writer", error: masterData("INVENTORY_CHANNEL_EXPOSURE_STALE_VARIANT_MAPPING"), kind: "transient", code: "INVENTORY_CHANNEL_EXPOSURE_STALE_VARIANT_MAPPING", scope: "row" },
  { source: "draft writer", error: masterData("INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_CONFLICT"), kind: "permanent", code: "INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_CONFLICT", scope: "row" },
  { source: "draft writer", error: masterData("INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_RECEIPT_INVALID"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "INVENTORY_CHANNEL_EXPOSURE_IDEMPOTENCY_RECEIPT_INVALID" },
  { source: "draft writer (§4.4)", error: masterData("INVENTORY_PUBLICATION_VARIANT_MAPPING_HISTORY_INVALID"), kind: "permanent", code: "INVENTORY_PUBLICATION_VARIANT_MAPPING_HISTORY_INVALID", scope: "row" },
  { source: "draft writer predecessor_chk", error: pgError("23514"), kind: "permanent", code: "STOCK_LINK_CHECK_VIOLATION", scope: "row", causeCode: "23514" },
  { source: "mapping trigger", error: pgError("P0001", "one provider inventory item cannot map to multiple SKUs in the same publication target"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "P0001" },
  { source: "unique key", error: pgError("23505"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "23505" },
  // The enqueue's TRY lock on the pair.
  { source: "enqueue", error: new InventoryAvailabilityRuntimePublicationError("INVENTORY_PUBLICATION_TARGET_BUSY", "busy", { retryable: true }), kind: "busy", code: "INVENTORY_PUBLICATION_TARGET_BUSY", scope: "row" },
  // SQLSTATEs.
  { source: "serialization", error: pgError("40001"), kind: "busy", code: "STOCK_LINK_DATABASE_BUSY", scope: "row", causeCode: "40001" },
  { source: "deadlock", error: pgError("40P01"), kind: "busy", code: "STOCK_LINK_DATABASE_BUSY", scope: "row", causeCode: "40P01" },
  { source: "statement timeout", error: pgError("57014"), kind: "transient", code: "STOCK_LINK_STATEMENT_TIMEOUT", scope: "row", causeCode: "57014" },
  // Lost or unavailable connection: the tick stops (TST-2).
  ...["57P01", "57P02", "57P03", "53300", "08006", "08003", "08001"].map((code): Case => ({ source: `connection ${code}`,
    error: pgError(code), kind: "database_unavailable", code: "STOCK_LINK_DATABASE_UNAVAILABLE", scope: "tick", causeCode: code })),
  { source: "socket", error: withCode("ECONNRESET", "read ECONNRESET"), kind: "database_unavailable", code: "STOCK_LINK_DATABASE_UNAVAILABLE", scope: "tick", causeCode: "ECONNRESET" },
  { source: "code-less drop", error: new Error("Connection terminated unexpectedly"), kind: "database_unavailable", code: "STOCK_LINK_DATABASE_UNAVAILABLE", scope: "tick", causeCode: null },
  { source: "pool timeout", error: new Error("timeout exceeded when trying to connect"), kind: "database_unavailable", code: "STOCK_LINK_DATABASE_UNAVAILABLE", scope: "tick", causeCode: null },
  { source: "dead client", error: new Error("Client has encountered a connection error and is not queryable"), kind: "database_unavailable", code: "STOCK_LINK_DATABASE_UNAVAILABLE", scope: "tick", causeCode: null },
  // Adapter (§6.1): every provider read is a batch read, so its failures are destination-scoped (SAF-9).
  { source: "adapter 5xx", error: new StockLinkError("STOCK_LINK_PROVIDER_UNAVAILABLE", "x"), kind: "transient", code: "STOCK_LINK_PROVIDER_UNAVAILABLE", scope: "destination" },
  { source: "adapter envelope", error: new StockLinkError("STOCK_LINK_PROVIDER_RESPONSE_INVALID", "x"), kind: "transient", code: "STOCK_LINK_PROVIDER_RESPONSE_INVALID", scope: "destination" },
  { source: "adapter paging", error: new StockLinkError("STOCK_LINK_LOOKUP_INCOMPLETE", "x"), kind: "transient", code: "STOCK_LINK_LOOKUP_INCOMPLETE", scope: "destination" },
  { source: "adapter cost floor", error: new StockLinkError("STOCK_LINK_PROVIDER_COST_FLOOR", "x"), kind: "busy", code: "STOCK_LINK_PROVIDER_COST_FLOOR", scope: "destination" },
  { source: "adapter 401/403", error: new StockLinkError("STOCK_LINK_STORE_AUTH_REFUSED", "x"), kind: "pause", code: "STOCK_LINK_STORE_AUTH_REFUSED", scope: "destination" },
  { source: "adapter 402/423", error: new StockLinkError("STOCK_LINK_STORE_UNAVAILABLE", "x"), kind: "pause", code: "STOCK_LINK_STORE_UNAVAILABLE", scope: "destination" },
  { source: "adapter ACCESS_DENIED/404", error: new StockLinkError("STOCK_LINK_PROVIDER_REJECTED", "x"), kind: "fatal", code: "STOCK_LINK_PROVIDER_REJECTED", scope: "destination" },
  { source: "adapter count mismatch", error: new StockLinkError("STOCK_LINK_ADAPTER_CONTRACT", "x"), kind: "fatal", code: "STOCK_LINK_ADAPTER_CONTRACT", scope: "destination" },
  { source: "adapter gid", error: new StockLinkError("STOCK_LINK_ID_INVALID", "x"), kind: "fatal", code: "STOCK_LINK_ID_INVALID", scope: "destination" },
  // The engine's own codes.
  ...["STOCK_LINK_PAIR_BUSY", "STOCK_LINK_SCOPE_BUSY"].map((code): Case => ({ source: "engine lock", error: new StockLinkError(code, "x"), kind: "busy", code, scope: "row" })),
  ...["STOCK_LINK_FENCE_BUDGET_USED", "STOCK_LINK_CALL_BUDGET_USED"].map((code): Case => ({ source: "engine budget", error: new StockLinkError(code, "x"), kind: "busy", code, scope: "destination" })),
  ...["STOCK_LINK_CONNECTION_CHANGED", "STOCK_LINK_SKU_CHANGED_SINCE_READ", "STOCK_LINK_HEAD_CHANGED", "STOCK_LINK_CLAIM_LOST",
    "STOCK_LINK_EVIDENCE_STALE", "STOCK_LINK_LOOKUP_MISSED"].map((code): Case => ({ source: "engine race", error: new StockLinkError(code, "x"), kind: "transient", code, scope: "row" })),
  { source: "engine stop", error: new StockLinkError("STOCK_LINK_STORE_NOT_ANSWERING", "x"), kind: "pause", code: "STOCK_LINK_STORE_NOT_ANSWERING", scope: "destination" },
  { source: "engine", error: new StockLinkError("STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY", "x"), kind: "permanent", code: "STOCK_MAPPING_LINK_CHANGED_AFTER_APPLY", scope: "row" },
  { source: "engine", error: new StockLinkError("STOCK_LINK_CHECK_VIOLATION", "x"), kind: "permanent", code: "STOCK_LINK_CHECK_VIOLATION", scope: "row" },
  ...["STOCK_LINK_POLICY_MISSING", "STOCK_LINK_ROLLBACK_FAILED", "STOCK_LINK_STATE_INVALID"].map((code): Case => ({ source: "engine invariant", error: new StockLinkError(code, "x"), kind: "fatal", code, scope: "destination" })),
  // Anything else.
  { source: "zod", error: new ZodError([]), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "ZodError" },
  { source: "plain error", error: new Error("boom"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "UNKNOWN" },
  { source: "a thrown string", error: "boom", kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "UNKNOWN" },
  { source: "null", error: null, kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "UNKNOWN" },
  { source: "unknown code", error: withCode("SOMETHING_NEW"), kind: "fatal", code: "STOCK_LINK_UNCLASSIFIED", scope: "destination", causeCode: "SOMETHING_NEW" },
];

const CLASS_OF: Record<StockLinkFailureKind, "transient" | "permanent" | "fatal"> = {
  busy: "transient", transient: "transient", database_unavailable: "transient", cleanup_uncertain: "transient",
  pause: "transient", permanent: "permanent", fatal: "fatal",
};

describe("classifyStockLinkFailure (enumerated)", () => {
  for (const testCase of cases) {
    it(`${testCase.source}: ${testCase.code}${testCase.causeCode ? ` (${testCase.causeCode})` : ""} → ${testCase.kind}`, () => {
      const result = classifyStockLinkFailure(testCase.error);
      expect(result).toMatchObject({ kind: testCase.kind, code: testCase.code, scope: testCase.scope,
        errorClass: CLASS_OF[testCase.kind], countsAttempt: testCase.kind === "transient" });
      if (testCase.causeCode !== undefined) expect(result.causeCode).toBe(testCase.causeCode);
    });
  }

  it("a provider's Retry-After travels with a throttle; a malformed one is ignored", () => {
    expect(classifyStockLinkFailure(new StockLinkError("STOCK_LINK_PROVIDER_THROTTLED", "x", {}, { retryAfterMs: 30_000 })))
      .toMatchObject({ kind: "transient", scope: "destination", retryAfterMs: 30_000 });
    for (const bad of [-1, 1.5, Number.NaN, "30"]) {
      expect(classifyStockLinkFailure(Object.assign(new Error("x"), { code: "STOCK_LINK_PROVIDER_THROTTLED", retryAfterMs: bad })).retryAfterMs)
        .toBeNull();
    }
  });

  it("a StockLinkError's class follows its code; an unknown code is fatal", () => {
    expect(new StockLinkError("STOCK_LINK_PAIR_BUSY", "x").errorClass).toBe("transient");
    expect(new StockLinkError("STOCK_MAPPING_COMMAND_CONFLICT", "x").errorClass).toBe("permanent");
    expect(new StockLinkError("NOT_A_CODE", "x").errorClass).toBe("fatal");
    const cause = new Error("root");
    expect(new StockLinkError("STOCK_LINK_HEAD_CHANGED", "x", { productVariantId: 1 }, { cause })).toMatchObject({
      name: "StockLinkError", code: "STOCK_LINK_HEAD_CHANGED", context: { productVariantId: 1 }, cause });
  });

  it("every code has exactly one kind, and every decision transient code is classified", () => {
    const sets = [STOCK_LINK_BUSY_CODES, STOCK_LINK_TRANSIENT_CODES, STOCK_LINK_PAUSE_CODES, STOCK_LINK_PERMANENT_CODES, STOCK_LINK_FATAL_CODES];
    const all = sets.flatMap(set => [...set]);
    expect(new Set(all).size).toBe(all.length);
    for (const code of all) expect(stockLinkCodeKind(code)).not.toBeNull();
    expect(stockLinkCodeKind(STOCK_LINK_DECISION_CODES.lookupMissed)).toBe("transient");
    expect(stockLinkCodeKind(STOCK_LINK_DECISION_CODES.notRead)).toBe("busy");
    expect(stockLinkCodeKind(STOCK_LINK_DECISION_CODES.storeNotAnswering)).toBe("pause");
    for (const code of [...all, ...Object.values(STOCK_LINK_DECISION_CODES)]) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(code.length).toBeLessThanOrEqual(120);
    }
  });
});
