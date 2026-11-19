import { describe, expect, it, vi } from "vitest";
import { admitEbayPublication } from "../../ebay-publication-admission.service";
import { storedEbayListingSyncJobSchema, EbayListingSyncError } from "../../ebay-listing-sync.domain";

const input = {productId:232,actor:"operator",commandKey:"18000000-0000-4000-8000-000000000001"};
function fixture() {
  const identity={channelId:67,connectionId:12,productId:232,accountId:"seller",marketplaceId:"EBAY_US",groupKey:null,
    variants:[{variantId:463,sku:"SKU-P10",catalogSku:"SKU-P10",externalSku:null,offerId:"offer-1",listingId:null,mappingExists:true}]};
  const job=storedEbayListingSyncJobSchema.parse({id:"18000000-0000-4000-8000-000000000002",productId:232,operation:"publish",
    state:"queued",code:null,message:null,nextAttemptAt:"2026-10-11T12:00:00Z",updatedAt:"2026-10-11T12:00:00Z",
    identity,revision:"1",claimedRevision:null,ownerToken:null,attempts:0,result:null,verificationIntentHash:null,verificationRevision:null});
  const jobs={getByCommand:vi.fn(async()=>null as typeof job|null),getAdmission:vi.fn(async()=>null),
    enqueue:vi.fn(async()=>structuredClone(job)),recordAdmissionFailure:vi.fn(async()=>({...job,kind:"admission" as const,state:"needs_attention" as const}))};
  const readSource=vi.fn(async()=>structuredClone(identity));
  return {job,identity,jobs,readSource,deps:{channelId:67,jobs,readSource}};
}

describe("durable eBay publication admission",()=>{
  it("saves one exact publication command without claiming publication completed",async()=>{
    const f=fixture();const before=structuredClone(f.identity);
    expect(await admitEbayPublication(input,f.deps)).toMatchObject({productId:232,status:"queued",success:false,job:{operation:"publish"}});
    expect(f.jobs.enqueue).toHaveBeenCalledExactlyOnceWith(before,"operator",input.commandKey,"publish");
    expect(f.identity).toEqual(before); expect(f.jobs.recordAdmissionFailure).not.toHaveBeenCalled();
  });
  it("retrieves a committed publication before looking at now-published local inputs",async()=>{
    const f=fixture();f.job.state="completed";f.job.providerIdentity={...f.identity,variants:[{...f.identity.variants[0]!,externalSku:"SKU-P10",listingId:"live-1"}]};
    f.job.result={synced:1,priceChanges:0,qtyChanges:0,policyChanges:0,errors:0,pending:0,jobs:[],details:[]};
    f.jobs.getByCommand.mockResolvedValue(f.job);f.jobs.enqueue.mockResolvedValue(f.job);
    f.readSource.mockRejectedValue(new Error("Current source is legitimately different"));
    expect(await admitEbayPublication(input,f.deps)).toMatchObject({status:"success",listingId:"live-1"});
    expect(f.readSource).not.toHaveBeenCalled();expect(f.jobs.enqueue).toHaveBeenCalledExactlyOnceWith(f.job.identity,"operator",input.commandKey,"publish");
  });
  it.each(["product","operation"])("does not reuse a command with different %s",async field=>{
    const f=fixture();if(field==="product")f.job.productId=99;else f.job.operation="sync";
    f.jobs.getByCommand.mockResolvedValue(f.job);
    expect(await admitEbayPublication(input,f.deps)).toMatchObject({status:"error",code:"EBAY_SYNC_REPLAY_CONFLICT"});
    expect(f.jobs.enqueue).not.toHaveBeenCalled();expect(f.jobs.recordAdmissionFailure).not.toHaveBeenCalled();
  });
  it("retains the command when its commit response is lost instead of sealing a false refusal",async()=>{
    const f=fixture();f.jobs.enqueue.mockRejectedValue(Object.assign(new Error("socket closed"),{code:"ECONNRESET"}));
    expect(await admitEbayPublication(input,f.deps)).toMatchObject({status:"error",code:"EBAY_SYNC_ADMISSION_UNSAVED"});
    expect(f.jobs.recordAdmissionFailure).not.toHaveBeenCalled();
  });
  it("preserves an explicit prior-publication blocker and the exact saved-job action",async()=>{
    const f=fixture();
    f.jobs.enqueue.mockRejectedValue(Object.assign(new EbayListingSyncError("EBAY_PUBLICATION_PRIOR_WORK_REQUIRED","Review the prior publication before starting a different request."),{jobId:f.job.id}));
    expect(await admitEbayPublication(input,f.deps)).toMatchObject({status:"error",code:"EBAY_PUBLICATION_PRIOR_WORK_REQUIRED",issue:{reference:f.job.id}});
    expect(f.jobs.recordAdmissionFailure).not.toHaveBeenCalled();
  });
  it("journals a pre-admission eligibility refusal for retrieval and correction",async()=>{
    const f=fixture();f.readSource.mockRejectedValue(new EbayListingSyncError("EBAY_LISTING_PREFLIGHT_FAILED","Enable this product before publishing."));
    expect(await admitEbayPublication(input,f.deps)).toMatchObject({status:"error",job:{kind:"admission"}});
    expect(f.jobs.enqueue).not.toHaveBeenCalled();expect(f.jobs.recordAdmissionFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      channelId:67,productId:232,commandKey:input.commandKey,actor:"operator",code:"EBAY_LISTING_PREFLIGHT_FAILED"}));
  });
  it("does not seal an uncertain source read as a permanent eligibility refusal", async () => {
    const f = fixture(); f.readSource.mockRejectedValueOnce(new Error("connection lost"));
    expect(await admitEbayPublication(input, f.deps)).toMatchObject({ code: "EBAY_SYNC_ADMISSION_UNSAVED" });
    expect(f.jobs.recordAdmissionFailure).not.toHaveBeenCalled(); expect(f.jobs.enqueue).not.toHaveBeenCalled();
    expect(await admitEbayPublication(input, f.deps)).toMatchObject({ status: "queued" });
    expect(f.jobs.enqueue).toHaveBeenCalledOnce();
  });
  it("rejects malformed commands before reading anything",async()=>{
    const f=fixture();await expect(admitEbayPublication({...input,commandKey:"no"},f.deps)).rejects.toThrow();
    expect(f.jobs.getByCommand).not.toHaveBeenCalled();expect(f.readSource).not.toHaveBeenCalled();
  });
});
