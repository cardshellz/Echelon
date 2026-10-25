import { describe, expect, it } from "vitest";
import { auditMoneyReadBoundaries, unsafeMoneyReads } from "../../../scripts/money-read-boundaries.mjs";

describe("money read boundaries", () => {
  it("rejects native decimal and database integer coercions, including unnamed scaled values", () => {
    expect(unsafeMoneyReads("Number(row.total_cents); parseFloat(item.price); Math.round(parseFloat(value) * 100);", "fixture.ts"))
      .toHaveLength(3);
    expect(unsafeMoneyReads("readIntegerCents(row.total_cents); parseDecimalCents(item.price); Number(item.quantity); parseFloat(discountPercent);", "fixture.ts"))
      .toEqual([]);
  });

  it("has no unreviewed monetary coercions at server, shared or operational-script boundaries", async () => {
    const allowed = [
      { file: "shared/money-read.ts", expression: "Number(formatCentsExact(cents))", reason: "Numeric-dollar wire conversion checks the exact cent round-trip before returning." },
      { file: "shared/utils/money.ts", expression: "Number(mills)", reason: "Both exact BigInt mills parsers check the safe-integer bound immediately before conversion." },
      { file: "shared/dropship/pricing-rules.ts", expression: "Number(cents)", reason: "Recipe evaluation bounds the exact BigInt result against MAX_LISTING_PRICE_CENTS before conversion." },
    ];
    expect(await auditMoneyReadBoundaries(process.cwd(), allowed)).toEqual([]);
  }, 30_000);
});
