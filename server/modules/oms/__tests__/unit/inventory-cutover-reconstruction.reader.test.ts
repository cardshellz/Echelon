import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readOmsCutoverReconstruction } from "../../inventory-cutover-reconstruction.reader";
import { CUTOVER_RECEIPT_EVIDENCE_FORMAT } from "../../domain/inventory-cutover-receipt-evidence";

function receipt(id = "1") {
  return { id, status: "review", evidence: {
    format: CUTOVER_RECEIPT_EVIDENCE_FORMAT, databaseRowHash: "a".repeat(64),
  } };
}

describe("OMS cutover compact census boundary", () => {
  it("reads the complete receipt census in one bounded statement, never independent pages", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [receipt()] });
    const result = await readOmsCutoverReconstruction({ query } as unknown as PoolClient);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual([CUTOVER_RECEIPT_EVIDENCE_FORMAT, 100001]);
    expect(query.mock.calls[1][0]).toContain("ORDER BY receipt.id LIMIT $2");
    expect(result.shipmentReviewEvidence).toEqual([{ id: "1", kind: "channel_fulfillment_receipt",
      status: "review", evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });

  it("stops before receipt work when accepted demand exceeds the complete census bound", async () => {
    const query = vi.fn().mockResolvedValue({ rows: Array(100001).fill({}) });
    await expect(readOmsCutoverReconstruction({ query } as unknown as PoolClient))
      .rejects.toMatchObject({ code: "OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("rejects receipt overflow before classification instead of returning a partial result", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: Array(100001).fill({ private: "must not appear in error" }) });
    await expect(readOmsCutoverReconstruction({ query } as unknown as PoolClient))
      .rejects.toMatchObject({ code: "OMS_CUTOVER_CENSUS_LIMIT_EXCEEDED",
        message: "OMS cutover evidence exceeds the complete bounded census; no partial result is returned." });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("accepts exactly 100000 complete receipt rows without a sentinel omission", async () => {
    const rows = Array.from({ length: 100000 }, (_, index) => receipt(String(index + 1)));
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows });
    const result = await readOmsCutoverReconstruction({ query } as unknown as PoolClient);
    expect(result.shipmentReviewEvidence).toHaveLength(100000);
    expect(new Set(result.shipmentReviewEvidence.map((row) => row.id)).size).toBe(100000);
    expect(query).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("propagates a failed receipt statement rather than returning demand-only readiness", async () => {
    const failure = Object.assign(new Error("statement cancelled"), { code: "57014" });
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure);
    await expect(readOmsCutoverReconstruction({ query } as unknown as PoolClient)).rejects.toBe(failure);
  });
});
