import { describe, expect, it, vi } from "vitest";
import { EbayListingPushService, EbayListingPushSkipped, ebayListingPushFailure, ebayListingPushRequestSchema } from "../../ebay-listing-push.service";
import { ebayListingPushResponseSchema } from "@shared/types/ebay-listing-push";

describe("shared eBay publication batch", () => {
  it.each(["EBAY_CATALOG_PHOTO_REQUIRED", "EBAY_LISTING_PREFLIGHT_FAILED", "STOCK_LISTING_ATP_NOT_READY", "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED", "EBAY_AUTH_REQUIRED"])(
    "isolates %s and emits its actionable result before continuing other products", async code => {
      const execute = vi.fn(async (id: number) => {
        if (id === 1) throw Object.assign(new Error("The first product cannot proceed."), { code });
        return { productId: id, productName: "Second", success: true, status: "success" as const, variantCount: 2, listingId: "listing-2" };
      });
      const onProduct = vi.fn();
      const result = await new EbayListingPushService({ execute }).push({ productIds: [1, 2] }, { onProduct });
      expect(result.summary).toEqual({ succeeded: 1, failed: 1, skipped: 0, queued: 0, total: 2 });
      expect(result.results[0]).toMatchObject({ productId: 1, success: false, code, issue: { code } });
      expect(result.results[0].issue?.nextStep).toBeTruthy();
      expect(result.results[1].listingId).toBe("listing-2");
      expect(onProduct).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls.map(args => args[0])).toEqual([1, 2]);
    });

  it("stops only between completed product workflows when the stream disconnects", async () => {
    let cancelled = false;
    const execute = vi.fn(async (id: number) => {
      cancelled = true;
      return { productId: id, productName: "Finished", success: true, status: "success" as const, variantCount: 1 };
    });
    const result = await new EbayListingPushService({ execute }).push({ productIds: [1, 2] }, { cancelled: () => cancelled });
    expect(result.summary).toMatchObject({ total: 1, succeeded: 1 });
    expect(result.cancelled).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("counts exclusions separately and redacts sensitive provider diagnostics", async () => {
    const execute = vi.fn(async () => { throw new EbayListingPushSkipped("Product is excluded."); });
    const result = await new EbayListingPushService({ execute }).push({ productIds: [1] });
    expect(result.summary).toEqual({ succeeded: 0, failed: 0, skipped: 1, queued: 0, total: 1 });
    expect(ebayListingPushFailure(1, new Error("Authorization: Bearer secret https://user:pass@example.com" )).error).not.toContain("secret");
  });

  it.each([[1, 1], [0], [-1], [2_147_483_648], [], Array.from({ length: 501 }, (_, i) => i + 1)].map(productIds => ({ productIds })))("rejects invalid scope before provider work", async ({ productIds }) => {
    const execute = vi.fn();
    await expect(new EbayListingPushService({ execute }).push({ productIds })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a reviewed confirmation for another product", () => {
    expect(ebayListingPushRequestSchema.safeParse({ productIds: [1], updateExisting: { mode: "execute", preview: {
      productId: 2, groupKey: "group", currentExternalListingId: "listing", sourceState: "active", currentSkus: ["sku"],
      activeSkus: ["sku"], inactiveSkus: [], desiredSkus: ["sku"], addedSkus: [], removedSkus: [], rebuildRequired: false,
      confirmationToken: "a".repeat(64),
    } } }).success).toBe(false);
  });

  it.each([
    { name: "no saved request", jobId: undefined, reference: undefined,
      action: { kind: "edit_listing", label: "Open listing feed", href: "/channels/ebay" } },
    { name: "a saved request", jobId: "18000000-0000-4000-8000-000000000002", reference: "18000000-0000-4000-8000-000000000002",
      action: { kind: "check_status", label: "View saved update details" } },
    { name: "an invalid request reference", jobId: "invalid-reference", reference: undefined,
      action: { kind: "edit_listing", label: "Open listing feed", href: "/channels/ebay" } },
  ])("keeps database diagnostics private and offers read-only navigation with $name", ({ jobId, reference, action }) => {
    const failure = ebayListingPushFailure(20, Object.assign(new Error("duplicate key: confidential database value"), { code: "23505", jobId }));
    expect(failure).toMatchObject({ code: "EBAY_LISTING_OPERATION_FAILED", success: false, status: "error",
      issue: { code: "EBAY_LISTING_OPERATION_FAILED", retryable: false } });
    expect(failure.issue?.action).toEqual(action);
    expect(failure.issue?.reference).toBe(reference);
    expect(JSON.stringify(failure)).not.toContain("confidential");
    expect(JSON.stringify(failure)).not.toContain("23505");
    expect(JSON.stringify(failure)).not.toContain("invalid-reference");
  });
  it("counts a saved publication as queued and retains its exact request and actor", async () => {
    const commandKey="18000000-0000-4000-8000-000000000001";
    const job={id:"18000000-0000-4000-8000-000000000002",productId:1,kind:"sync" as const,operation:"publish" as const,
      state:"queued" as const,code:null,message:null,nextAttemptAt:"2026-10-11T12:00:00Z",updatedAt:"2026-10-11T12:00:00Z"};
    const execute=vi.fn(async()=>({productId:1,productName:"First",variantCount:2,success:false,status:"queued" as const,job}));
    const request={productIds:[1],commands:[{productId:1,commandKey}]};
    const result=await new EbayListingPushService({execute}).push(request,{actor:"operator"});
    expect(result.summary).toEqual({succeeded:0,failed:0,skipped:0,queued:1,total:1});
    expect(execute).toHaveBeenCalledExactlyOnceWith(1,request,undefined,"operator");
    expect(ebayListingPushResponseSchema.parse(result).results[0]).toMatchObject({success:false,status:"queued",job:{id:job.id}});
    expect(ebayListingPushResponseSchema.safeParse({...result,results:[{...result.results[0],success:true}]}).success).toBe(false);
  });
  it.each([
    [{productId:2,commandKey:"18000000-0000-4000-8000-000000000001"}],
    [],
    [{productId:1,commandKey:"invalid"}],
    [{productId:1,commandKey:"18000000-0000-4000-8000-000000000001"},{productId:1,commandKey:"18000000-0000-4000-8000-000000000002"}],
  ].map(commands=>({commands})))("refuses incomplete or mismatched command scopes", ({commands})=>{
    expect(ebayListingPushRequestSchema.safeParse({productIds:[1],commands}).success).toBe(false);
  });
});
