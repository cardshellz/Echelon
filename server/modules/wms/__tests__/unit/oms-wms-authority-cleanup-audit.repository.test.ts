import { describe, expect, it, vi } from "vitest";
import {
  InvalidAuthorityCleanupAuditInputError,
  recordOmsWmsAuthorityCleanupAudit,
  type OmsWmsAuthorityCleanupAuditInput,
} from "../../oms-wms-authority-cleanup-audit.repository";

const VALID_INPUT: OmsWmsAuthorityCleanupAuditInput = {
  runId: "11111111-1111-4111-8111-111111111111",
  operation: "historical-refund-authority-repair",
  sourceTable: "oms.oms_order_lines",
  sourceId: 110466,
  action: "update",
  reason: "historical persisted refund authority repair",
  beforeRow: { id: 110466, authority_fulfillable_quantity: 5 },
  afterRow: { id: 110466, authority_fulfillable_quantity: 0 },
  operator: "owner@cardshellz.com",
  createdAt: new Date("2026-07-26T12:00:00.000Z"),
};

function queryText(query: any): string {
  return (query?.queryChunks ?? [])
    .flatMap((chunk: any) => {
      if (chunk == null) return [];
      if (typeof chunk === "string") return [chunk];
      if (Array.isArray(chunk.value)) return chunk.value;
      if (chunk.value !== undefined) return [String(chunk.value)];
      return [];
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

describe("recordOmsWmsAuthorityCleanupAudit", () => {
  it("appends the audit through the caller's transaction handle", async () => {
    const tx = {
      execute: vi.fn(async () => ({ rows: [] })),
    };

    await recordOmsWmsAuthorityCleanupAudit(tx, VALID_INPUT);

    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(queryText(tx.execute.mock.calls[0][0])).toContain(
      "INSERT INTO wms.oms_wms_authority_cleanup_audit",
    );
  });

  it.each([
    [{ runId: "not-a-uuid" }, "runId must be a UUID"],
    [{ sourceId: 0 }, "sourceId must be a positive safe integer"],
    [{ action: "replace" }, "action must be one of update, delete"],
    [{ operation: " " }, "operation is required"],
    [{ sourceTable: " " }, "sourceTable is required"],
    [{ reason: " " }, "reason is required"],
    [{ operator: " " }, "operator is required"],
    [{ createdAt: new Date("invalid") }, "createdAt must be a valid Date"],
    [{ beforeRow: [] }, "beforeRow must be an object"],
    [{ beforeRow: { invalid: 1n } }, "beforeRow must be JSON serializable"],
  ])("rejects invalid audit input before writing: %#", async (override, message) => {
    const tx = {
      execute: vi.fn(async () => ({ rows: [] })),
    };

    await expect(recordOmsWmsAuthorityCleanupAudit(tx, {
      ...VALID_INPUT,
      ...override,
    } as OmsWmsAuthorityCleanupAuditInput)).rejects.toEqual(
      expect.objectContaining<Partial<InvalidAuthorityCleanupAuditInputError>>({
        name: "InvalidAuthorityCleanupAuditInputError",
        message: expect.stringContaining(message),
      }),
    );
    expect(tx.execute).not.toHaveBeenCalled();
  });
});
