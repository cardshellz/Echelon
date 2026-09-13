/**
 * The readout is the operator's only signal for which allocator is live, so
 * the builder must refuse everything except one contract-valid singleton row.
 */
import { describe, expect, it } from "vitest";
import {
  buildInventoryRuntimeAuthorityReadout,
  InventoryRuntimeAuthorityReadoutError,
  type InventoryRuntimeAuthorityRecord,
} from "../../domain/inventory-runtime-authority-readout";
import { liveAllocatorForAuthority } from "@shared/types/inventory-runtime-authority";

const CHANGED_AT = "2026-09-12T14:00:00.000Z";

function legacyRecord(overrides: Partial<InventoryRuntimeAuthorityRecord> = {}): InventoryRuntimeAuthorityRecord {
  return {
    authority: "legacy",
    revision: "1",
    activationRunId: null,
    changedBy: "migration-0638",
    changeReason: "Initialize inactive inventory availability cutover authority.",
    changedAt: CHANGED_AT,
    ...overrides,
  };
}

function canonicalRecord(overrides: Partial<InventoryRuntimeAuthorityRecord> = {}): InventoryRuntimeAuthorityRecord {
  return legacyRecord({
    authority: "canonical",
    revision: "7",
    activationRunId: "42",
    changedBy: "operator-9",
    changeReason: "Cutover commit after verified opening.",
    ...overrides,
  });
}

function failure(records: readonly InventoryRuntimeAuthorityRecord[]): InventoryRuntimeAuthorityReadoutError {
  try {
    buildInventoryRuntimeAuthorityReadout(records);
  } catch (error) {
    if (error instanceof InventoryRuntimeAuthorityReadoutError) return error;
    throw error;
  }
  throw new Error("expected the builder to refuse the records");
}

describe("liveAllocatorForAuthority", () => {
  it("maps legacy to Channel Allocation rules and canonical to Inventory Exposure", () => {
    expect(liveAllocatorForAuthority("legacy")).toBe("channel_allocation_rules");
    expect(liveAllocatorForAuthority("canonical")).toBe("inventory_exposure");
  });
});

describe("buildInventoryRuntimeAuthorityReadout", () => {
  it("reports the legacy authority as Channel Allocation rules being live", () => {
    expect(buildInventoryRuntimeAuthorityReadout([legacyRecord()])).toEqual({
      contractVersion: "inventory_runtime_authority_readout_v1",
      authority: "legacy",
      liveAllocator: "channel_allocation_rules",
      revision: "1",
      activationRunId: null,
      changedBy: "migration-0638",
      changeReason: "Initialize inactive inventory availability cutover authority.",
      changedAt: CHANGED_AT,
    });
  });

  it("reports the canonical authority as Inventory Exposure being live with its activation lineage", () => {
    expect(buildInventoryRuntimeAuthorityReadout([canonicalRecord()])).toMatchObject({
      authority: "canonical",
      liveAllocator: "inventory_exposure",
      revision: "7",
      activationRunId: "42",
    });
  });

  it("trims actor text without mutating the record it was given", () => {
    const record = legacyRecord({ changedBy: "  operator-1  ", changeReason: "  reason  " });
    const frozen = Object.freeze({ ...record });
    expect(buildInventoryRuntimeAuthorityReadout([frozen])).toMatchObject({ changedBy: "operator-1", changeReason: "reason" });
    expect(frozen).toEqual(record);
  });

  it.each([
    { records: [], rowCount: 0 },
    { records: [legacyRecord(), legacyRecord()], rowCount: 2 },
  ])("refuses a missing or duplicated singleton ($rowCount rows)", ({ records, rowCount }) => {
    const error = failure(records);
    expect(error).toMatchObject({
      status: 503, code: "INVENTORY_RUNTIME_AUTHORITY_UNAVAILABLE", classification: "permanent", context: { rowCount },
    });
  });

  it.each([
    ["legacy with an activation run", legacyRecord({ activationRunId: "5" }), "activationRunId"],
    ["canonical without an activation run", canonicalRecord({ activationRunId: null }), "activationRunId"],
    ["an unknown authority", legacyRecord({ authority: "shadow" }), "authority"],
    ["a zero revision", legacyRecord({ revision: "0" }), "revision"],
    ["a numeric revision that lost its text form", legacyRecord({ revision: 1 }), "revision"],
    ["a blank actor", legacyRecord({ changedBy: "   " }), "changedBy"],
    ["a missing reason", legacyRecord({ changeReason: undefined }), "changeReason"],
    ["a non-ISO timestamp", legacyRecord({ changedAt: "yesterday" }), "changedAt"],
  ])("refuses %s as a permanent contract violation", (_label, record, path) => {
    const error = failure([record]);
    expect(error).toMatchObject({ status: 503, code: "INVENTORY_RUNTIME_AUTHORITY_INVALID", classification: "permanent" });
    expect((error.context.issues as Array<{ path: string }>).map((issue) => issue.path)).toContain(path);
  });

  it("never lets an unknown authority pick an allocator by default", () => {
    const error = failure([legacyRecord({ authority: "" })]);
    const paths = (error.context.issues as Array<{ path: string }>).map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(["authority", "liveAllocator"]));
  });
});
