import { describe, expect, it } from "vitest";
import { ebayProductExclusionResultSchema } from "@shared/types/ebay-listing-exclusion";
const commandKey = "11111111-1111-4111-8111-111111111111";
const included = { success: true, productId: 1, excluded: false, commandKey, replayed: false, job: null, remoteAction: "included" };
describe("inclusion sync receipt scope", () => {
  it("accepts the exact shared batch and historical receipts without a batch", () => {
    expect(ebayProductExclusionResultSchema.safeParse({ ...included, syncBatchId: commandKey }).success).toBe(true);
    expect(ebayProductExclusionResultSchema.safeParse(included).success).toBe(true);
  });
  it.each([
    { syncBatchId: "22222222-2222-4222-8222-222222222222" },
    { syncBatchId: commandKey, excluded: true },
    { syncBatchId: commandKey, remoteAction: "local_exclusion" },
  ])("rejects a batch belonging to another command or disposition: %j", changes => {
    expect(ebayProductExclusionResultSchema.safeParse({ ...included, ...changes }).success).toBe(false);
  });
});
