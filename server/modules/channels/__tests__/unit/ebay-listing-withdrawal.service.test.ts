import { describe, expect, it, vi } from "vitest";
import { EbayListingWithdrawalExecution } from "../../ebay-listing-withdrawal.service";
import { EbayMarketplaceRegistrationObserver } from "../../../marketplace-listings/infrastructure/providers/ebay/ebay-registration-observer";
import type { QuantityPublicationScope } from "../../../inventory-planning/domain/quantity-publication-admission";
import type { EbayListingSyncIdentity } from "../../ebay-listing-sync.domain";
import type { EbayListingExecutionContext } from "../../ebay-listing-sync.service";

function fixture(grouped = true) {
  const source: EbayListingSyncIdentity = { channelId:67,connectionId:34,productId:3,accountId:"seller",marketplaceId:"EBAY_US",groupKey:"CATALOG-CLR",
    variants:[{variantId:6,sku:"SHLZ-TOP-180PT-P10",catalogSku:"SHLZ-TOP-180PT-CLR-P10",externalSku:"SHLZ-TOP-180PT-P10",offerId:"offer-6",listingId:"298148206427",contentSyncEnabled:false},
      ...(grouped?[{variantId:7,sku:"SHLZ-TOP-180PT-C500",catalogSku:"SHLZ-TOP-180PT-CLR-C500",externalSku:"SHLZ-TOP-180PT-C500",offerId:"offer-7",listingId:"298148206427",contentSyncEnabled:false}]:[])] };
  const state = { published:true,visible:true,wrongOffer:false,wrongAccount:false,extraMember:false };
  const groupKey=grouped?"SHLZ-TOP-180PT":null;
  const observer=new EbayMarketplaceRegistrationObserver({loadFreshCredential:async()=>({accessToken:"test-only",environment:"production"})},{get:async request=>{
    const url=new URL(request.path,"https://unused.invalid");
    if(url.pathname.includes("/identity/"))return{status:200,body:{userId:state.wrongAccount?"other":source.accountId}};
    if(url.pathname.includes("/inventory_item_group/"))return{status:200,body:{variantSKUs:[...source.variants.map(member=>member.sku),...(state.extraMember?["FOREIGN"]:[])]}};
    if(url.pathname.includes("/inventory_item/"))return{status:200,body:{sku:decodeURIComponent(url.pathname.split("/").at(-1)!),groupIds:groupKey?[groupKey]:[]}};
    const sku=url.searchParams.get("sku")!;const member=source.variants.find(row=>row.sku===sku)!;
    const published=state.published||!state.visible;
    return{status:200,body:{total:1,offers:[{sku,offerId:state.wrongOffer?"foreign":member.offerId,marketplaceId:"EBAY_US",format:"FIXED_PRICE",
      status:published?"PUBLISHED":"UNPUBLISHED",...(published?{listing:{listingId:"298148206427",listingStatus:"ACTIVE"}}:{})}]}};
  }},{now:()=>new Date("2026-10-12T15:00:00Z")});
  const inspect=()=>observer.inspectExistingPublication({owner:{kind:"channel",channelId:67,productId:3,provider:"ebay",marketplaceId:"EBAY_US"},
    memberCandidates:source.variants.map(member=>({productVariantId:member.variantId,sku:member.sku,isActive:true,availableQuantity:0}))});
  const client={withdrawOffer:vi.fn(async()=>{state.published=false;}),withdrawOfferByInventoryItemGroup:vi.fn(async()=>{state.published=false;})};
  const recovery={reconcile:vi.fn(async(_scopes:readonly QuantityPublicationScope[]):Promise<{busy:boolean;resolved:string[];unresolved:string[]}>=>({busy:false,resolved:[],unresolved:[]}))};
  const context:EbayListingExecutionContext={operation:"withdraw",providerIdentity:null,withdrawalWriteCompleted:false,publicationTarget:null,
    publicationAccepted:null,publicationWriteStarted:false,publicationWriteCompleted:false,publicationAcceptedRevision:null,publicationIntentHash:null,
    claimedRevision:"1",bindPublicationTarget:vi.fn(),bindPublicationAccepted:vi.fn()};
  const bind=vi.fn(async(identity:EbayListingSyncIdentity)=>{context.providerIdentity=identity;});
  const stages:string[]=[];
  const stage=async(key:string,_hash:string,work:()=>Promise<void>)=>{stages.push(key);await work();if(key==="withdraw")context.withdrawalWriteCompleted=true;};
  const prepare=vi.fn(async()=>({sourceIdentity:structuredClone(source),inspect,client}));
  const executor=new EbayListingWithdrawalExecution(prepare,recovery);
  return {source,state,context,client,recovery,bind,stages,run:()=>executor.execute(source,stage,null,bind,context)};
}

describe("durable exact eBay withdrawal execution",()=>{
  it("withdraws the observed historical group despite a Catalog rename and verifies all offers",async()=>{
    const f=fixture();const before=structuredClone(f.source);expect(await f.run()).toMatchObject({synced:0,qtyChanges:0,errors:0});
    expect(f.client.withdrawOfferByInventoryItemGroup).toHaveBeenCalledExactlyOnceWith("SHLZ-TOP-180PT","EBAY_US");
    expect(f.client.withdrawOffer).not.toHaveBeenCalled();expect(f.stages).toEqual(["withdraw","verification"]);expect(f.source).toEqual(before);
    expect(f.recovery.reconcile.mock.calls[0][0].map(scope=>scope.externalInventoryItemId)).toEqual(["group:SHLZ-TOP-180PT",...f.source.variants.map(member=>member.sku)]);
  });
  it("uses the exact offer for a genuine single listing",async()=>{const f=fixture(false);await f.run();expect(f.client.withdrawOffer).toHaveBeenCalledExactlyOnceWith("offer-6");expect(f.client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();});
  it("adopts already-unpublished exact offers without another write and keeps historical listing IDs",async()=>{const f=fixture();f.state.published=false;await f.run();expect(f.client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();expect(f.context.providerIdentity?.variants.map(member=>member.listingId)).toEqual(["298148206427","298148206427"]);});
  it("checks readback only after accepted withdrawal while provider status lags",async()=>{const f=fixture();f.state.visible=false;
    await expect(f.run()).rejects.toMatchObject({code:"EBAY_WITHDRAWAL_READBACK_PENDING"});await expect(f.run()).rejects.toMatchObject({code:"EBAY_WITHDRAWAL_READBACK_PENDING"});
    expect(f.client.withdrawOfferByInventoryItemGroup).toHaveBeenCalledTimes(1);f.state.visible=true;expect((await f.run()).errors).toBe(0);expect(f.client.withdrawOfferByInventoryItemGroup).toHaveBeenCalledTimes(1);});
  it("retains a freshly observed listing ID when legacy local rows had no listing ID",async()=>{const f=fixture();f.source.variants=f.source.variants.map(member=>({...member,listingId:null}));await f.run();await f.run();expect(f.context.providerIdentity?.variants[0].listingId).toBe("298148206427");expect(f.client.withdrawOfferByInventoryItemGroup).toHaveBeenCalledTimes(1);});
  it.each(["wrongOffer","wrongAccount","extraMember"] as const)("refuses %s before provider mutation",async kind=>{const f=fixture();f.state[kind]=true;await expect(f.run()).rejects.toThrow();expect(f.client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();});
  it("retains unknown inventory effects for explicit recovery rather than inferring success",async()=>{const f=fixture();f.recovery.reconcile.mockResolvedValue({busy:false,resolved:[],unresolved:["18294"]});await expect(f.run()).rejects.toMatchObject({code:"EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED"});expect(f.client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();});
  it("cannot send withdrawal without the saved operation owner",async()=>{const f=fixture();f.context.operation="publish";await expect(f.run()).rejects.toMatchObject({code:"EBAY_WITHDRAWAL_OWNER_REQUIRED"});expect(f.client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();});
  it("a started withdrawal without completion stays read-only until exact unpublished readback or explicit recovery",async()=>{
    const f=fixture();f.context.withdrawalWriteStarted=true;
    await expect(f.run()).rejects.toMatchObject({code:"EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN"});expect(f.client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
    f.state.published=false;expect((await f.run()).errors).toBe(0);expect(f.client.withdrawOfferByInventoryItemGroup).not.toHaveBeenCalled();
  });
});
