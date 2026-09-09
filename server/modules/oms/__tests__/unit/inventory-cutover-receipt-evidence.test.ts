import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@shared/utils/canonical-json";
import { CUTOVER_RECEIPT_EVIDENCE_FORMAT, groupCutoverReceiptEvidence } from "../../domain/inventory-cutover-receipt-evidence";

function receipt(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, status: "ignored", errorCode: null, attemptOutcome: "ignored",
    attemptErrorCode: null, sourceEcho: true, attemptCount: 2, attemptNumber: 2,
    sourceProvider: "shopify", sourceChannelId: "36", sourceOrderId: "provider-order",
    sourceFulfillmentId: "provider-package", omsOrderId: "500", physicalShipmentId: "700",
    evidence: { format: CUTOVER_RECEIPT_EVIDENCE_FORMAT,
      databaseRowHash: digest({ receipt: { id, raw_payload: { lines: [1, 2] } },
        latestAttempt: { attempt_number: 2, metadata: { sourceEcho: true } } }) },
    ...overrides,
  };
}

const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const groupId = `package:700:scope:${digest(["shopify", "36", "provider-order", "provider-package", "500", "700"])}`;

describe("cutover recorded shipment acknowledgment evidence", () => {
  it("groups only clean recorded acknowledgments and retains a review evidence record", () => {
    const first = receipt("1"), second = receipt("2");
    expect(groupCutoverReceiptEvidence([first, second])).toEqual([{
      id: groupId, kind: "channel_fulfillment_acknowledgment", status: "ignored",
      evidenceHash: digest({ identity: groupId, receipts: [
        { id: first.id, evidence: first.evidence }, { id: second.id, evidence: second.evidence },
      ] }),
    }]);
  });

  it.each([
    ["false echo", { sourceEcho: false }], ["string echo", { sourceEcho: "true" }],
    ["null echo", { sourceEcho: null }], ["absent echo", { sourceEcho: undefined }],
    ["pending receipt", { status: "pending" }], ["processing receipt", { status: "processing" }],
    ["review receipt", { status: "review" }], ["processed input", { status: "processed" }],
    ["receipt error", { errorCode: "INVENTORY_RECORD_FAILED" }],
    ["empty receipt error", { errorCode: "" }], ["absent receipt error", { errorCode: undefined }],
    ["attempt error", { attemptErrorCode: "RECEIPT_LEASE_EXPIRED" }],
    ["absent attempt error", { attemptErrorCode: undefined }],
    ["expired latest attempt", { attemptOutcome: "lease_expired" }],
    ["review latest attempt", { attemptOutcome: "review" }],
    ["processed latest attempt", { attemptOutcome: "processed" }],
    ["missing latest attempt", { attemptOutcome: null, attemptNumber: null }],
    ["newer pending attempt", { attemptCount: 3 }], ["attempt ahead of receipt", { attemptNumber: 3 }],
    ["zero attempts", { attemptCount: 0, attemptNumber: 0 }],
    ["fractional attempt", { attemptCount: 2.5, attemptNumber: 2.5 }],
    ["string attempt", { attemptCount: "2", attemptNumber: "2" }],
    ["missing provider", { sourceProvider: null }], ["empty provider", { sourceProvider: "" }],
    ["missing channel", { sourceChannelId: null }], ["numeric channel", { sourceChannelId: 36 }],
    ["invalid channel", { sourceChannelId: "0" }], ["missing source order", { sourceOrderId: null }],
    ["empty source order", { sourceOrderId: "" }], ["missing fulfillment", { sourceFulfillmentId: null }],
    ["empty fulfillment", { sourceFulfillmentId: "" }], ["missing OMS order", { omsOrderId: null }],
    ["missing physical package", { physicalShipmentId: null }],
    ["malformed physical package", { physicalShipmentId: "1e3" }],
    ["overlength source order", { sourceOrderId: "x".repeat(201) }],
  ] satisfies Array<[string, Record<string, unknown>]>) (
    "keeps %s as an individual receipt rather than granting acknowledgment classification", (_label, override) => {
      const invalid = receipt("2", override);
      const result = groupCutoverReceiptEvidence([receipt("1"), invalid]);
      expect(result).toHaveLength(2);
      expect(result).toContainEqual({ id: "2", kind: "channel_fulfillment_receipt",
        status: invalid.status, evidenceHash: digest(invalid.evidence) });
    },
  );

  it.each([
    ["provider", { sourceProvider: "ebay" }], ["channel", { sourceChannelId: "37" }],
    ["source order", { sourceOrderId: "other-order" }],
    ["fulfillment", { sourceFulfillmentId: "other-package" }],
    ["OMS order", { omsOrderId: "501" }], ["physical package", { physicalShipmentId: "701" }],
  ] satisfies Array<[string, Record<string, unknown>]>) (
    "does not collapse duplicate-looking packages across %s scope", (_label, override) => {
      const result = groupCutoverReceiptEvidence([receipt("1"), receipt("2", override)]);
      expect(result).toHaveLength(2);
      expect(result.every((entry) => entry.kind === "channel_fulfillment_acknowledgment")).toBe(true);
      expect(new Set(result.map((entry) => entry.id)).size).toBe(2);
    },
  );

  it("hashes complete identity tuples so separator and percent characters cannot collide", () => {
    const result = groupCutoverReceiptEvidence([
      receipt("1", { sourceOrderId: "a:b", sourceFulfillmentId: "c%3Ad" }),
      receipt("2", { sourceOrderId: "a", sourceFulfillmentId: "b:c%3Ad" }),
    ]);
    expect(result.map((row) => row.id)).toEqual([
      `package:700:scope:${digest(["shopify", "36", "a:b", "c%3Ad", "500", "700"])}`,
      `package:700:scope:${digest(["shopify", "36", "a", "b:c%3Ad", "500", "700"])}`,
    ].sort());
  });

  it("keeps long external identities complete while bounding the persisted review subject", () => {
    const sourceOrderId = "o".repeat(200), sourceFulfillmentId = "f".repeat(200);
    const result = groupCutoverReceiptEvidence([
      receipt("1", { sourceOrderId, sourceFulfillmentId, physicalShipmentId: "9223372036854775807" }),
      receipt("2", { sourceOrderId: `${"o".repeat(199)}p`, sourceFulfillmentId, physicalShipmentId: "9223372036854775807" }),
    ]);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((entry) => entry.id)).size).toBe(2);
    for (const entry of result) expect(`${entry.kind}:${entry.id}`.length).toBeLessThan(200);
    expect(result).toContainEqual(expect.objectContaining({
      id: `package:9223372036854775807:scope:${digest(["shopify", "36", sourceOrderId, sourceFulfillmentId, "500", "9223372036854775807"])}`,
    }));
  });

  it("sorts complete bigint receipt identities numerically without precision loss", () => {
    const rows = [receipt("9007199254740993"), receipt("10"), receipt("9007199254740992"), receipt("2")];
    const result = groupCutoverReceiptEvidence(rows);
    const ordered = [rows[3], rows[1], rows[2], rows[0]];
    expect(result[0].evidenceHash).toBe(digest({ identity: groupId,
      receipts: ordered.map(({ id, evidence }) => ({ id, evidence })) }));
    expect(groupCutoverReceiptEvidence([...rows].reverse())).toEqual(result);
  });

  it("is deterministic across input order and reordered compact evidence object keys", () => {
    const first = receipt("1");
    const equivalent = receipt("1", { evidence: {
      databaseRowHash: first.evidence.databaseRowHash, format: CUTOVER_RECEIPT_EVIDENCE_FORMAT,
    } });
    expect(groupCutoverReceiptEvidence([first, receipt("2")]))
      .toEqual(groupCutoverReceiptEvidence([receipt("2"), equivalent]));
  });

  it("invalidates the group hash for added, removed, replaced or changed member evidence", () => {
    const first = receipt("1"), second = receipt("2");
    const baseline = groupCutoverReceiptEvidence([first, second])[0].evidenceHash;
    for (const changed of [
      [first], [first, second, receipt("3")], [first, receipt("3")],
      [first, receipt("2", { evidence: { ...second.evidence, databaseRowHash: digest("changed receipt field") } })],
      [first, receipt("2", { evidence: { ...second.evidence, databaseRowHash: digest("changed latest attempt") } })],
    ]) expect(groupCutoverReceiptEvidence(changed)[0].evidenceHash).not.toBe(baseline);
  });

  it("includes fallback receipt payload and attempt evidence in the individual hash", () => {
    const original = receipt("1", { sourceEcho: false });
    const changed = { ...original, evidence: { ...original.evidence, databaseRowHash: digest("changed latest attempt") } };
    expect(groupCutoverReceiptEvidence([original])[0].evidenceHash)
      .not.toBe(groupCutoverReceiptEvidence([changed])[0].evidenceHash);
  });

  it("does not mutate caller arrays or deeply frozen evidence", () => {
    const input = [receipt("2"), receipt("1"), receipt("3", { status: "review" })];
    const snapshot = structuredClone(input);
    function freezeDeep(value: unknown): void {
      if (value !== null && typeof value === "object") {
        for (const nested of Object.values(value)) freezeDeep(nested);
        Object.freeze(value);
      }
    }
    freezeDeep(input);
    groupCutoverReceiptEvidence(input);
    expect(input).toEqual(snapshot);
  });

  it("rejects duplicate receipt identities instead of hiding contradictory evidence", () => {
    expect(() => groupCutoverReceiptEvidence([receipt("1"), receipt("1", { status: "review" })]))
      .toThrow("OMS_CUTOVER_DUPLICATE_RECEIPT_IDENTITY");
  });

  it.each(["", "0", "-1", "01", "1.5", "1e3", "x", "1".repeat(20), 1, null])(
    "rejects malformed receipt identity %s", (id) => {
      expect(() => groupCutoverReceiptEvidence([receipt("1", { id })])).toThrow();
    },
  );

  it("rejects malformed rows and non-serializable evidence without issuing a trusted hash", () => {
    for (const row of [null, {}, { id: "1", status: null, evidence: {} }, receipt("1", { evidence: undefined }),
      receipt("1", { evidence: null }), receipt("1", { evidence: "not-an-object" }),
      receipt("1", { evidence: { invalid: BigInt(1) } }), receipt("1", { evidence: { nested: { absent: undefined } } }),
      receipt("1", { evidence: { nested: [undefined] } }), receipt("1", { evidence: { invalid: () => 1 } }),
      receipt("1", { evidence: { invalid: Number.NaN } }), receipt("1", { evidence: { invalid: Number.POSITIVE_INFINITY } })]) {
      expect(() => groupCutoverReceiptEvidence([row])).toThrow();
    }
  });

  it.each([
    {}, { format: CUTOVER_RECEIPT_EVIDENCE_FORMAT },
    { format: "inventory_cutover_receipt_digest_v1", databaseRowHash: "a".repeat(64) },
    { format: CUTOVER_RECEIPT_EVIDENCE_FORMAT, databaseRowHash: "A".repeat(64) },
    { format: CUTOVER_RECEIPT_EVIDENCE_FORMAT, databaseRowHash: "a".repeat(63) },
    { format: CUTOVER_RECEIPT_EVIDENCE_FORMAT, databaseRowHash: null },
    { format: CUTOVER_RECEIPT_EVIDENCE_FORMAT, databaseRowHash: "a".repeat(64), ignoredField: "not allowed" },
    { receiptJson: "{}", latestAttemptJson: null },
  ])("rejects absent, malformed or unversioned database digest evidence: %#", (evidence) => {
    expect(() => groupCutoverReceiptEvidence([receipt("1", { evidence })])).toThrow();
  });

  it("returns no invented evidence for an empty census", () => {
    expect(groupCutoverReceiptEvidence([])).toEqual([]);
  });
});
