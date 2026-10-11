import { describe, expect, it, vi } from "vitest";
import { EbayListingMappingService, type EbayListingMappingSource, type EbayListingMappingRepairPlan, type EbayListingMappingRejectedCommand } from "../../ebay-listing-mapping.service";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import type { EbayRegistrationReadRequest, EbayRegistrationReadResponse } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-contracts";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";
import { ebayListingMappingResultSchema } from "@shared/types/ebay-listing-mapping";

const now = new Date("2026-10-10T12:00:00Z");
const commandKey = "60000000-0000-4000-8000-000000000001";
const jobId = "60000000-0000-4000-8000-000000000002";
type Offer = { sku?: string; offerId: string; status: string; marketplaceId: string; listing?: { listingId: string; listingStatus: string } };
function fixture() {
  const source: EbayListingMappingSource = { environment: "production", identity: { channelId: 67, connectionId: 12, productId: 20,
    accountId: "seller", marketplaceId: "EBAY_US", groupKey: null,
    variants: [101,102].map((variantId,index) => ({ variantId, sku: index ? "SHLZ-TOP-180PT-BLU-C500" : "SHLZ-TOP-180PT-BLU-P10",
      catalogSku: index ? "SHLZ-TOP-180PT-BLU-C500" : "SHLZ-TOP-180PT-BLU-P10", externalSku: index ? "SHLZ-TOP-180PT-BLU-C500" : "SHLZ-TOP-180PT-BLU-P10",
      offerId: `offer-${variantId}`, listingId: null, contentSyncEnabled: true })) }, candidates: [] };
  source.candidates = source.identity.variants.map(member => ({ productVariantId: member.variantId, sku: member.sku, isActive: true, availableQuantity: 17 }));
  const state = { accountId: "seller", environment: "production" as "production" | "sandbox", groupKey: "ACTUAL-EBAY-GROUP",
    groupSkus: source.identity.variants.map(member => member.sku), missingItems: new Set<string>(), statusForSku: new Map<string,number>(),
    offers: new Map(source.identity.variants.map(member => [member.sku, [{ sku: member.sku, offerId: member.offerId!, status: "PUBLISHED",
      marketplaceId: "EBAY_US", listing: { listingId: "listing-live", listingStatus: "ACTIVE" } }] as Offer[]])) };
  const transport = { get: vi.fn(async (request: EbayRegistrationReadRequest): Promise<EbayRegistrationReadResponse> => {
    const url = new URL(request.path,"https://api.ebay.com");
    if (url.pathname === "/commerce/identity/v1/user/") return { status:200,body:{userId:state.accountId,username:"seller"} };
    if (url.pathname.includes("/inventory_item_group/")) return { status:200,body:{variantSKUs:state.groupSkus} };
    if (url.pathname.includes("/inventory_item/")) {
      const sku = decodeURIComponent(url.pathname.split("/").at(-1)!);
      return state.missingItems.has(sku) ? {status:404,body:{}} : {status:200,body:{sku,groupIds:[state.groupKey]}};
    }
    if (url.pathname.endsWith("/offer")) {
      const sku = url.searchParams.get("sku")!;
      const status = state.statusForSku.get(sku) ?? 200;
      const all = state.offers.get(sku) ?? [];
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return {status,body:{offers:all.slice(offset,offset+limit),total:all.length}};
    }
    throw new Error("Unexpected provider read");
  }) };
  const observer = new EbayMarketplaceRegistrationObserver({loadFreshCredential:async()=>({accessToken:"fixture-only",environment:state.environment})},transport,{now:()=>now,pageSize:1});
  const result = ebayListingMappingResultSchema.parse({ repairStatus:"queued",replayed:false,receipt:{commandKey,productId:20,reviewHash:"a".repeat(64),appliedAt:now.toISOString()},
    job:{id:jobId,productId:20,state:"queued",code:null,message:null,nextAttemptAt:now.toISOString(),updatedAt:now.toISOString()} });
  const store = { findReplay:vi.fn(async()=>null as typeof result|null),
    apply:vi.fn(async (plan:EbayListingMappingRepairPlan)=>({...structuredClone(result),receipt:{...result.receipt,reviewHash:plan.reviewHash}})),
    rejectReviewedCommand:vi.fn(async (input:EbayListingMappingRejectedCommand):Promise<typeof result>=>{throw new EbayListingSyncError(input.code,input.message);}),
  };
  const readSource = vi.fn(async()=>structuredClone(source));
  const inspect = vi.fn((input:Parameters<typeof observer.inspectExistingPublication>[0])=>observer.inspectExistingPublication(input));
  const assertCompatible = vi.fn(async()=>undefined);
  const reportDiagnosticFailure = vi.fn();
  const service = new EbayListingMappingService({readSource,inspect,assertCompatible,store,now:()=>now,reportDiagnosticFailure});
  return {source,state,transport,observer,readSource,inspect,assertCompatible,store,result,service,reportDiagnosticFailure};
}

describe("fresh eBay mapping diagnosis and reviewed repair",()=>{
  it("proves the incident's nullable saved listing IDs are fillable through the complete canonical group",async()=>{
    const f=fixture();const before=structuredClone(f.source);
    const review=await f.service.diagnose(20,67);
    expect(review).toMatchObject({canApply:true,action:{kind:"apply_fix"},rows:[{problem:"mapping_missing"},{problem:"mapping_missing"}],
      membership:{groupKey:"ACTUAL-EBAY-GROUP",missingSkus:[],extraSkus:[]}});
    expect(review.rows[0]!.observedOffers).toEqual([{sku:f.source.identity.variants[0]!.sku,offerId:"offer-101",status:"PUBLISHED",listingId:"listing-live",listingStatus:"ACTIVE"}]);
    expect(f.store.apply).not.toHaveBeenCalled();
    expect(f.source).toEqual(before);
    const result=await f.service.apply(20,67,"operator",{reviewHash:review.reviewHash,commandKey});
    expect(result).toMatchObject({repairStatus:"queued",receipt:{commandKey,productId:20}});
    expect(f.store.apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({actor:"operator",source:before,
      provenIdentity:expect.objectContaining({groupKey:"ACTUAL-EBAY-GROUP",variants:expect.arrayContaining([expect.objectContaining({variantId:101,listingId:"listing-live",offerId:"offer-101"})])})}));
    expect(f.assertCompatible).toHaveBeenCalledTimes(2);
  });
  it("recommends resuming when the saved IDs already match, instead of falsely diagnosing stale mapping",async()=>{
    const f=fixture();f.source.identity.variants.forEach(member=>{member.listingId="listing-live";});
    expect(await f.service.diagnose(20,67)).toMatchObject({canApply:true,action:{kind:"resume_sync"},rows:[{problem:"matches"},{problem:"matches"}]});
  });
  it("describes the exact stale offer while requiring complete account and membership proof",async()=>{
    const f=fixture();f.source.identity.variants[0]!.offerId="old-offer";
    const review=await f.service.diagnose(20,67);
    expect(review.rows[0]).toMatchObject({savedOfferId:"old-offer",problem:"offer_changed"});
    expect(review.rows[0]!.recommendation).toContain("offer-101");expect(review.canApply).toBe(true);
  });
  it.each(["account","environment"])("refuses a different live %s despite identical SKUs",async field=>{
    const f=fixture();if(field==="account")f.state.accountId="other-seller";else f.state.environment="sandbox";
    expect(await f.service.diagnose(20,67)).toMatchObject({canApply:false,action:{kind:"reconnect"}});
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it.each([[401,"reconnect","EBAY_AUTH_REQUIRED"],[403,"reconnect","EBAY_PROVIDER_ACCESS_DENIED"],
    [429,"retry_read","EBAY_PROVIDER_RATE_LIMITED"],[503,"retry_read","EBAY_REGISTRATION_READ_FAILED"]])("preserves HTTP%s as a read failure, not stale mapping",async(status,kind,code)=>{
    const f=fixture();f.state.statusForSku.set(f.source.identity.variants[0]!.sku,Number(status));
    const review=await f.service.diagnose(20,67);
    expect(review).toMatchObject({canApply:false,diagnosticCode:code,action:{kind},rows:[{problem:"read_failed"},{problem:"mapping_missing"}]});
    await expect(f.service.apply(20,67,"operator",{reviewHash:"a".repeat(64),commandKey})).rejects.toMatchObject({code});
    expect(f.store.apply).not.toHaveBeenCalled();
    expect(f.store.rejectReviewedCommand).not.toHaveBeenCalled();
  });
  it.each(["missing","unpublished","ambiguous","missing-sku","ended"])("explains %s without offering a mapping bypass",async mode=>{
    const f=fixture();const sku=f.source.identity.variants[0]!.sku;const offers=f.state.offers.get(sku)!;
    if(mode==="missing")f.state.offers.set(sku,[]);
    if(mode==="unpublished"){offers[0]!.status="UNPUBLISHED";delete offers[0]!.listing;}
    if(mode==="ambiguous")offers.push({...offers[0]!,offerId:"another-published-offer"});
    if(mode==="missing-sku")delete offers[0]!.sku;
    if(mode==="ended")offers[0]!.listing!.listingStatus="ENDED";
    const review=await f.service.diagnose(20,67);
    expect(review.canApply).toBe(false);
    expect(review.rows[0]!.problem).toBe(mode==="missing-sku"||mode==="ended"?"invalid_response":mode);
    if(mode==="ended")expect(review.rows[0]!.recommendation).toContain("ENDED");
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it("reports extra full-group SKUs even when that extra offer is unpublished",async()=>{
    const f=fixture();f.state.groupSkus.push("OTHER-PRODUCT-SKU");
    f.state.offers.set("OTHER-PRODUCT-SKU",[{sku:"OTHER-PRODUCT-SKU",offerId:"extra",status:"UNPUBLISHED",marketplaceId:"EBAY_US"}]);
    expect(await f.service.diagnose(20,67)).toMatchObject({canApply:false,diagnosticCode:"EBAY_SYNC_MEMBERSHIP_CHANGED",
      membership:{extraSkus:["OTHER-PRODUCT-SKU"]}});
  });
  it("retains group membership evidence when verification fails on an extra missing inventory item",async()=>{
    const f=fixture();f.state.groupSkus.push("MISSING-EXTRA-SKU");f.state.missingItems.add("MISSING-EXTRA-SKU");
    expect(await f.service.diagnose(20,67)).toMatchObject({canApply:false,membership:{groupKey:"ACTUAL-EBAY-GROUP",extraSkus:["MISSING-EXTRA-SKU"]}});
  });
  it("blocks separately registered publication conflicts before offering or persisting repair",async()=>{
    const f=fixture();f.assertCompatible.mockRejectedValue(new EbayListingSyncError("EBAY_MAPPING_CANONICAL_CONFLICT","incompatible"));
    const review=await f.service.diagnose(20,67);
    expect(review).toMatchObject({canApply:false,diagnosticCode:"EBAY_MAPPING_CANONICAL_CONFLICT",action:{kind:"review_registered_listing"}});
    await expect(f.service.apply(20,67,"operator",{reviewHash:"a".repeat(64),commandKey})).rejects.toMatchObject({code:"EBAY_MAPPING_CANONICAL_CONFLICT"});
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it("preserves trusted local ownership conflicts with the exact conflicting variant and SKU",async()=>{
    const f=fixture();f.assertCompatible.mockRejectedValue(new EbayListingSyncError("EBAY_MAPPING_OWNERSHIP_CONFLICT","eBay SKU SHLZ-TOP-180PT-BLU-P10 is already owned by local variant 999."));
    const review=await f.service.diagnose(20,67);
    expect(review).toMatchObject({canApply:false,diagnosticCode:"EBAY_MAPPING_OWNERSHIP_CONFLICT",action:{kind:"manual"}});
    expect(review.explanation).toContain("variant 999");expect(review.explanation).toContain("SHLZ-TOP-180PT-BLU-P10");
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it("refuses variants that resolve to distinct live listings rather than choosing either publication",async()=>{
    const f=fixture();f.state.offers.get(f.source.identity.variants[1]!.sku)![0]!.listing!.listingId="other-listing";
    expect(await f.service.diagnose(20,67)).toMatchObject({canApply:false,diagnosticCode:"EBAY_REGISTRATION_LISTING_AMBIGUOUS"});
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it("does not queue a guaranteed ineligible sync when all content is disabled",async()=>{
    const f=fixture();f.source.identity.variants.forEach(member=>{member.contentSyncEnabled=false;});
    const review=await f.service.diagnose(20,67);
    expect(review).toMatchObject({canApply:false,diagnosticCode:"EBAY_MAPPING_PRODUCT_NOT_ELIGIBLE",action:{label:"Review local inclusion"}});
    expect(review.manualSteps[0]).toMatchObject({href:"/channels/ebay"});
    expect(review.manualSteps.some(step=>step.href?.includes("ebay.com"))).toBe(false);
  });
  it("keeps a review stable across quantity changes, but refuses changed offer identity",async()=>{
    const f=fixture();const first=await f.service.diagnose(20,67);
    f.source.candidates=f.source.candidates.map(candidate=>({...candidate,availableQuantity:999}));
    expect((await f.service.diagnose(20,67)).reviewHash).toBe(first.reviewHash);
    f.state.offers.get(f.source.identity.variants[0]!.sku)![0]!.offerId="new-after-preview";
    await expect(f.service.apply(20,67,"operator",{reviewHash:first.reviewHash,commandKey})).rejects.toMatchObject({code:"EBAY_MAPPING_REVIEW_STALE"});
    expect(f.store.apply).not.toHaveBeenCalled();
    expect(f.store.rejectReviewedCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({commandKey,reviewHash:first.reviewHash,code:"EBAY_MAPPING_REVIEW_STALE"}));
  });
  it("returns the concurrent winning receipt instead of claiming a stale command did not apply",async()=>{
    const f=fixture();const first=await f.service.diagnose(20,67);
    f.state.offers.get(f.source.identity.variants[0]!.sku)![0]!.offerId="new-after-preview";
    f.store.rejectReviewedCommand.mockResolvedValue({...f.result,replayed:true,receipt:{...f.result.receipt,reviewHash:first.reviewHash!}});
    expect(await f.service.apply(20,67,"operator",{reviewHash:first.reviewHash,commandKey})).toMatchObject({repairStatus:"queued",replayed:true});
    expect(f.store.apply).not.toHaveBeenCalled();
  });
  it("seals a rolled-back source fence refusal before permitting another review",async()=>{
    const f=fixture();const review=await f.service.diagnose(20,67);
    f.store.apply.mockRejectedValue(new EbayListingSyncError("EBAY_MAPPING_REVIEW_CHANGED","The mapping changed during apply."));
    await expect(f.service.apply(20,67,"operator",{reviewHash:review.reviewHash,commandKey})).rejects.toMatchObject({code:"EBAY_MAPPING_REVIEW_CHANGED"});
    expect(f.store.rejectReviewedCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({code:"EBAY_MAPPING_REVIEW_CHANGED",commandKey}));
  });
  it("preserves an uncertain persistence outcome without writing a false rejection",async()=>{
    const f=fixture();const review=await f.service.diagnose(20,67);
    f.store.apply.mockRejectedValue(new EbayListingSyncError("EBAY_MAPPING_PERSISTENCE_FAILED","Commit response was lost."));
    await expect(f.service.apply(20,67,"operator",{reviewHash:review.reviewHash,commandKey})).rejects.toMatchObject({code:"EBAY_MAPPING_PERSISTENCE_FAILED"});
    expect(f.store.rejectReviewedCommand).not.toHaveBeenCalled();
  });
  it("reports inability to save a refusal as uncertain, retaining the original command",async()=>{
    const f=fixture();f.state.offers.set(f.source.identity.variants[0]!.sku,[]);
    f.store.rejectReviewedCommand.mockRejectedValue(new EbayListingSyncError("EBAY_MAPPING_PERSISTENCE_FAILED","Refusal could not be recorded."));
    await expect(f.service.apply(20,67,"operator",{reviewHash:"a".repeat(64),commandKey})).rejects.toMatchObject({code:"EBAY_MAPPING_PERSISTENCE_FAILED"});
    expect(f.store.rejectReviewedCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({code:"EBAY_MAPPING_REPAIR_UNSAFE"}));
  });
  it("fences source mapping changes during provider reads",async()=>{
    const f=fixture();f.readSource.mockImplementation(async()=>{
      const copy=structuredClone(f.source);if(f.readSource.mock.calls.length>1)copy.identity.variants[0]!.offerId="concurrent-remap";return copy;
    });
    expect(await f.service.diagnose(20,67)).toMatchObject({canApply:false,diagnosticCode:"EBAY_MAPPING_REVIEW_STALE",action:{kind:"retry_read"}});
  });
  it("replays a committed command before any source, provider, or compatibility reads",async()=>{
    const f=fixture();f.store.findReplay.mockResolvedValue({...f.result,replayed:true});
    expect(await f.service.apply(20,67,"operator",{reviewHash:"a".repeat(64),commandKey})).toMatchObject({replayed:true});
    expect(f.readSource).not.toHaveBeenCalled();expect(f.inspect).not.toHaveBeenCalled();expect(f.assertCompatible).not.toHaveBeenCalled();expect(f.store.apply).not.toHaveBeenCalled();
  });
  it("rejects client-supplied identities before any reads",async()=>{
    const f=fixture();await expect(f.service.apply(20,67,"operator",{reviewHash:"a".repeat(64),commandKey,offerId:"client-choice"})).rejects.toThrow();
    expect(f.store.findReplay).not.toHaveBeenCalled();expect(f.readSource).not.toHaveBeenCalled();
  });
  it("returns a scoped receipt without a provider call and refuses wrong-product results",async()=>{
    const f=fixture();f.store.findReplay.mockResolvedValue(f.result);
    expect(await f.service.getReceipt(20,67,commandKey)).toEqual(f.result);
    expect(f.readSource).not.toHaveBeenCalled();
    f.store.findReplay.mockResolvedValue({...f.result,receipt:{...f.result.receipt,productId:99}});
    await expect(f.service.getReceipt(20,67,commandKey)).rejects.toMatchObject({code:"EBAY_MAPPING_RECEIPT_SCOPE_INVALID"});
  });
  it("refuses a replay receipt for a different review hash",async()=>{
    const f=fixture();f.store.findReplay.mockResolvedValue(f.result);
    await expect(f.service.apply(20,67,"operator",{reviewHash:"b".repeat(64),commandKey})).rejects.toMatchObject({code:"EBAY_MAPPING_RECEIPT_SCOPE_INVALID"});
    expect(f.readSource).not.toHaveBeenCalled();
  });
  it("classifies invalid saved source data before provider access",async()=>{
    const f=fixture();f.source.identity.variants[0]!.sku="";
    expect(await f.service.diagnose(20,67)).toMatchObject({canApply:false,diagnosticCode:"EBAY_MAPPING_SOURCE_INVALID"});
    expect(f.inspect).not.toHaveBeenCalled();
    const review=await f.service.diagnose(20,67);
    expect(review.manualSteps[0]!.text).toContain("product 20");
    expect(review.manualSteps[0]!.text).toContain("EBAY_MAPPING_SOURCE_INVALID");
    expect(review.manualSteps.some(step=>step.href?.includes("ebay.com"))).toBe(false);
  });
  it("hides unclassified SQL/credential failures while preserving a useful retry code",async()=>{
    const f=fixture();f.readSource.mockRejectedValue(new Error("postgres://secret:password SQL SELECT"));
    const review=await f.service.diagnose(20,67);
    expect(review).toMatchObject({canApply:false,diagnosticCode:"EBAY_REGISTRATION_READ_FAILED",action:{kind:"retry_read"}});
    expect(JSON.stringify(review)).not.toMatch(/secret|password|SELECT/);
    expect(f.reportDiagnosticFailure).toHaveBeenCalledExactlyOnceWith({productId:20,phase:"source",code:"EBAY_REGISTRATION_PROVIDER_READ_UNAVAILABLE",errorName:"Error"});
    expect(JSON.stringify(f.reportDiagnosticFailure.mock.calls)).not.toMatch(/secret|password|SELECT/);
  });
});
