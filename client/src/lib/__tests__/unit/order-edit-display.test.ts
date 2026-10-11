import { describe, expect, it } from "vitest";
import { groupOrderEditDisplayLines } from "../../order-edit-display";
import {
  orderEditOperationSchema,
  type OrderEditOperation,
} from "@shared/order-edits/order-edit.contract";

type Line = OrderEditOperation["lines"][number];
const line: Line = {
  id: "original",
  variantId: "gid://shopify/ProductVariant/10",
  title: "Sleeves",
  variantTitle: "Pack of 100",
  quantity: 1,
  totalCents: 233,
  added: false,
};

describe("order edit display grouping", () => {
  it("shows the original pack and three added packs as quantity four with their exact net total", () => {
    const input = [line, { ...line, id: "increase", quantity: 3, totalCents: 699 }];
    const before = structuredClone(input);
    expect(groupOrderEditDisplayLines(input)).toEqual([
      {
        key: `variant:${line.variantId}`,
        sourceLineIds: ["original", "increase"],
        title: "Sleeves",
        variantTitle: "Pack of 100",
        quantity: 4,
        totalCents: 932,
        added: false,
      },
    ]);
    expect(input).toEqual(before);
  });

  it("preserves a fixed reward used on only one of two differently priced lines", () => {
    const result = groupOrderEditDisplayLines([
      { ...line, totalCents: 10099 },
      { ...line, id: "increase", totalCents: 11999 },
    ]);
    expect(result).toMatchObject([{ quantity: 2, totalCents: 22098 }]);
  });

  it("keeps different pack and box variants separate even if their labels match", () => {
    const result = groupOrderEditDisplayLines([
      line,
      {
        ...line,
        id: "box",
        variantId: "gid://shopify/ProductVariant/11",
        added: true,
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((row) => row.added)).toEqual([false, true]);
  });

  it("never guesses identity for null IDs or older responses missing variant IDs", () => {
    const { variantId: _variantId, ...legacy } = line;
    const result = groupOrderEditDisplayLines([
      { ...line, variantId: null },
      { ...legacy, id: "legacy" },
      { ...legacy, id: "legacy-2" },
    ]);
    expect(result).toHaveLength(3);
    expect(new Set(result.map((row) => row.key)).size).toBe(3);
  });

  it("marks a wholly new variant added, while a quantity increase on an original variant is not a new product", () => {
    const newVariant = groupOrderEditDisplayLines([
      { ...line, added: true },
      { ...line, id: "second", added: true },
    ]);
    expect(newVariant[0].added).toBe(true);
    const increasedVariant = groupOrderEditDisplayLines([
      line,
      { ...line, id: "second", added: true },
    ]);
    expect(increasedVariant[0].added).toBe(false);
  });

  it.each(["quantity", "totalCents"] as const)(
    "keeps exact individual rows if grouped %s would exceed safe integer precision",
    (field) => {
      const inputs = [
        { ...line, [field]: Number.MAX_SAFE_INTEGER },
        { ...line, id: "second", [field]: 1 },
      ];
      const result = groupOrderEditDisplayLines(inputs);
      expect(result).toHaveLength(2);
      expect(result.map((row) => row[field])).toEqual([
        Number.MAX_SAFE_INTEGER, 1,
      ]);
    },
  );

  it("preserves zero values and stable first-seen product ordering", () => {
    const result = groupOrderEditDisplayLines([
      { ...line, quantity: 0, totalCents: 0 },
      {
        ...line,
        id: "new",
        variantId: "gid://shopify/ProductVariant/11",
        totalCents: 0,
      },
      { ...line, id: "increase" },
    ]);
    expect(result.map((row) => row.sourceLineIds)).toEqual([
      ["original", "increase"], ["new"],
    ]);
    expect(result.map((row) => row.totalCents)).toEqual([233, 0]);
  });
});

describe("display metadata boundary", () => {
  const lineSchema = orderEditOperationSchema.shape.lines.element;
  it("accepts both new identity metadata and legacy lines", () => {
    expect(lineSchema.parse(line)).toEqual(line);
    const { variantId: _id, added: _added, ...legacy } = line;
    expect(lineSchema.parse(legacy)).toEqual(legacy);
  });
  it("rejects incorrect variant identity and unsafe quantities", () => {
    expect(lineSchema.safeParse({
      ...line, variantId: "gid://shopify/Product/10",
    }).success).toBe(false);
    expect(lineSchema.safeParse({
      ...line, quantity: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);
  });
});
