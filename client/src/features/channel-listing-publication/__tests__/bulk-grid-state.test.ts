import { describe, expect, it } from "vitest";
import {
  bulkGridAttributePath,
  bulkDescriptionPreview,
  bulkGridCoreFieldRequired,
  bulkGridAttributeWriteConflicts,
  acknowledgeBulkGridAttributeWrite,
  bulkGridBufferKey,
  bulkGridPathsOverlap,
  discardBulkGridBuffers,
  parseBulkGridField,
  reconcileBulkGridControls,
  type BulkGridBuffer,
} from "../bulk-grid-state";

describe("bulk listing grid edit boundaries", () => {
  it("bounds an HTML description preview without replacing the editable source", () => {
    const original =
      '<p>Card &amp; sleeve</p><script>alert("no")</script><p>' +
      "X".repeat(30_000) +
      "</p>";
    const preview = bulkDescriptionPreview(original);
    expect(preview).toHaveLength(240);
    expect(preview).toMatch(/^Card & sleeve X/);
    expect(preview).not.toContain("<p>");
    expect(preview).not.toContain("alert");
    expect(preview.endsWith("…")).toBe(true);
    expect(original).toContain('<script>alert("no")</script>');
  });
  it("marks identity and price required for both methods and creation content required only for create", () => {
    for (const method of ["create", "match"] as const) {
      expect(bulkGridCoreFieldRequired("identifier", method)).toBe(true);
      expect(bulkGridCoreFieldRequired("priceOverrideCents", method)).toBe(
        true,
      );
    }
    expect(bulkGridCoreFieldRequired("description", "create")).toBe(true);
    expect(bulkGridCoreFieldRequired("description", "match")).toBe(false);
  });
  it("corrects one invalid array leaf through an atomic write without losing another invalid leaf", () => {
    const path = ["Visible", "quantities"];
    const amount = [...path, "0", "amount"];
    const weight = [...path, "0", "weight"];
    const keyFor = (leaf: string[]) =>
      bulkGridBufferKey(1, "attribute:" + JSON.stringify(leaf));
    const buffers = new Map<string, BulkGridBuffer>([
      [keyFor(amount), { raw: "-", error: "Enter a valid number" }],
      [keyFor(weight), { raw: ".", error: "Enter a valid number" }],
    ]);
    const attributes = { Visible: { quantities: [{ amount: 1, weight: 2 }] } };
    const updated = [{ amount: 0.75, weight: 2 }];
    expect(
      bulkGridAttributeWriteConflicts(
        buffers,
        1,
        path,
        updated,
        attributes,
        amount,
      ),
    ).toBe(false);
    const remaining = acknowledgeBulkGridAttributeWrite(
      buffers,
      1,
      path,
      amount,
    );
    expect(remaining.has(keyFor(amount))).toBe(false);
    expect(remaining.get(keyFor(weight))?.raw).toBe(".");
    expect(
      bulkGridAttributeWriteConflicts(
        remaining,
        1,
        path,
        [{ amount: 0.75, weight: 3 }],
        { Visible: { quantities: updated } },
        weight,
      ),
    ).toBe(false);
    expect(
      acknowledgeBulkGridAttributeWrite(remaining, 1, path, weight).size,
    ).toBe(0);
    expect(buffers.size).toBe(2);
  });
  it("blocks destructive group replacement while a descendant has unfinished input", () => {
    const path = ["Visible", "quantities"];
    const amount = [...path, "0", "amount"];
    const buffers = new Map<string, BulkGridBuffer>([
      [
        bulkGridBufferKey(1, "attribute:" + JSON.stringify(amount)),
        { raw: "-", error: "Invalid" },
      ],
    ]);
    const attributes = { Visible: { quantities: [{ amount: 1 }] } };
    for (const value of [undefined, [], [{ amount: 5 }]]) {
      expect(
        bulkGridAttributeWriteConflicts(buffers, 1, path, value, attributes),
      ).toBe(true);
    }
  });
  it("never reinterprets a previous enum choice against new conditional options", () => {
    const column = 'attribute:["Visible","choice"]';
    const accepted = bulkGridBufferKey(1, column);
    const rejected = bulkGridBufferKey(2, column);
    const pending = bulkGridBufferKey("shared", column);
    const original = new Map<string, BulkGridBuffer>([
      [accepted, { raw: "choice:0", error: null, controlSignature: "old" }],
      [
        rejected,
        { raw: "choice:0", error: "Rejected", controlSignature: "old" },
      ],
      [pending, { raw: "choice:0", error: null, controlSignature: "old" }],
    ]);
    const next = reconcileBulkGridControls(
      original,
      new Map([[column, "new"]]),
    );
    expect(next.has(accepted)).toBe(false);
    for (const key of [rejected, pending]) {
      expect(next.get(key)).toMatchObject({
        raw: "choice:0",
        staleControl: true,
        error: "Field options changed. Re-enter or discard this value.",
      });
    }
    expect(original.size).toBe(3);
    expect(reconcileBulkGridControls(original, new Map())).toBe(original);
    expect(
      reconcileBulkGridControls(original, new Map([[column, "old"]])),
    ).toBe(original);
  });
  it("parses exact cents and refuses incomplete or unsafe prices", () => {
    expect(parseBulkGridField("priceOverrideCents", "12.34")).toBe(1234);
    expect(parseBulkGridField("priceOverrideCents", "0.01")).toBe(1);
    expect(parseBulkGridField("priceOverrideCents", "")).toBeNull();
    for (const raw of ["-1", "0", "1.001", "1e2", "90071992547409.92", "-"]) {
      expect(() => parseBulkGridField("priceOverrideCents", raw)).toThrow();
    }
  });
  it("preserves identifier leading zeroes and validates identity per item", () => {
    expect(parseBulkGridField("identifier", "036000291452", "UPC")).toEqual({
      type: "UPC",
      value: "036000291452",
    });
    expect(parseBulkGridField("identifier", "  ", "GTIN")).toBeNull();
    expect(() =>
      parseBulkGridField("identifier", "1".repeat(33), "UPC"),
    ).toThrow();
  });
  it("restores inheritance only after explicit empty content edits", () => {
    expect(parseBulkGridField("brand", "  ")).toBeNull();
    expect(
      parseBulkGridField(
        "images",
        "https://example.test/a.png\nhttps://example.test/b.png",
      ),
    ).toEqual(["https://example.test/a.png", "https://example.test/b.png"]);
    expect(() => parseBulkGridField("images", "not an image URL")).toThrow();
    expect(() => parseBulkGridField("title", "a".repeat(501))).toThrow();
  });
  it("clears overlapping accepted attribute buffers without losing invalid or unrelated row drafts", () => {
    const width = bulkGridBufferKey(
      1,
      'attribute:["Visible","dimensions","width"]',
    );
    const height = bulkGridBufferKey(
      1,
      'attribute:["Visible","dimensions","height"]',
    );
    const otherRow = bulkGridBufferKey(
      2,
      'attribute:["Visible","dimensions","width"]',
    );
    const title = bulkGridBufferKey(1, "core:title");
    const original = new Map<string, BulkGridBuffer>([
      [width, { raw: "12.0", error: null }],
      [height, { raw: "-", error: "Enter a valid number" }],
      [otherRow, { raw: "8", error: null }],
      [title, { raw: "New title", error: null }],
    ]);
    const next = discardBulkGridBuffers(original, (key, value) => {
      const path = bulkGridAttributePath(key, 1);
      return (
        !value.error &&
        path !== null &&
        bulkGridPathsOverlap(path, ["Visible", "dimensions"])
      );
    });
    expect([...next.keys()]).toEqual([height, otherRow, title]);
    expect(original.size).toBe(4);
    expect(bulkGridAttributePath(title, 1)).toBeNull();
    expect(bulkGridAttributePath("1:attribute:invalid", 1)).toBeNull();
    expect(
      bulkGridPathsOverlap(["Visible", "width"], ["Visible", "widthUnit"]),
    ).toBe(false);
  });
});
