import { describe, expect, it, vi } from "vitest";
import { PackageReconciliationService } from "../../package-reconciliation.service";

const now=new Date('2026-09-17T14:00:00Z');
const request={sourceItemIds:[1],actor:'operator',reason:'Confirmed combined package',commandKey:'test-reconcile',correctedPreviousLabelIds:[]};
function fixture(options:{tracking?:string;quantity?:number;duplicate?:boolean;failAfterTracking?:boolean}={}){
  let tracking=options.tracking??'OLD';let stored=false;let failed=false;
  const scope={physicalShipmentId:500,omsOrderId:10,channelId:36,externalOrderId:'123',channelProvider:'shopify',
    trackingNumber:'NEW',carrier:'ups',items:[{channelOrderLineId:'100',quantity:2}],allowedPreviousTrackingNumbers:['OLD']};
  const native={request:vi.fn(async(query:string,variables:Record<string,unknown>)=>{
    if(query.includes('reconciliationFulfillmentHandles'))return{order:{id:'gid://shopify/Order/123',fulfillmentsCount:{count:options.duplicate?2:1},fulfillments:options.duplicate?[{id:'gid://shopify/Fulfillment/1'},{id:'gid://shopify/Fulfillment/2'}]:[{id:'gid://shopify/Fulfillment/1'}]}};
    if(query.includes('labelLifecyclePackages'))return{order:{id:'gid://shopify/Order/123',fulfillmentsCount:{count:options.duplicate?2:1},fulfillments:(options.duplicate?[1,2]:[1]).map(id=>({id:`gid://shopify/Fulfillment/${id}`,status:'SUCCESS',trackingInfo:[{number:tracking}]}))}};
    if(query.includes('labelLifecycleLines'))return{fulfillment:{id:variables.id,order:{id:'gid://shopify/Order/123'},fulfillmentLineItems:{nodes:[{lineItem:{id:'gid://shopify/LineItem/100'},quantity:options.quantity??2}],pageInfo:{hasNextPage:false,endCursor:null}}}};
    throw new Error('Unexpected provider operation');
  })};
  const command={commandKey:request.commandKey,expectedSnapshotHash:'a'.repeat(64),expectedPlanHash:'b'.repeat(64),sourceItemIds:[1],actor:request.actor,reason:request.reason,mode:'adopt_existing',correction:null,providerProof:null};
  const result={commandId:1,operationId:'11111111-1111-4111-8111-111111111111',evidenceHash:'b'.repeat(64),physicalShipmentIds:[500],channelCommandIds:[600],sourceItemIds:[1],omsOrderIds:[10],correctedPreviousLabelIds:[],replayed:false};
  const repository={loadPackageReconciliationSnapshot:vi.fn(),reconcilePackages:vi.fn(async()=>{stored=true;return result;}),
    completePackageReconciliation:vi.fn(async()=>({replayed:false,resolvedReviewIds:[700]})),readPackageReconciliationChannelScopes:vi.fn(async()=>[scope]),
    loadPackageReconciliationReplay:vi.fn(async()=>stored?{command,result,state:'applied'}:null),findPendingPackageReconciliations:vi.fn(async()=>[]),recordPackageReconciliationFailure:vi.fn()};
  Object.assign(repository,{markPackageReconciliationProjected:vi.fn()});
  const projector={projectPhysicalShipment:vi.fn()};const intent=vi.fn();
  const updateTracking=vi.fn(async()=>{tracking='NEW';if(options.failAfterTracking&&!failed){failed=true;throw new Error('timeout after provider accepted tracking');}});
  const channels={shopify:vi.fn(async()=>({channelId:36,connectionId:1,externalAccountId:'test.myshopify.com',client:native})),ebay:vi.fn()};
  const provider={load:vi.fn()};const logger={info:vi.fn(),error:vi.fn()};
  const service=new PackageReconciliationService({repository:repository as never,provider,channels:channels as never,projector,
    updateTracking,recordTrackingIntent:intent,runExclusive:async(_id,work)=>work(),clock:{now:()=>now},logger});
  // Allocation commit is exercised in PostgreSQL tests. This external-provider
  // test starts from that real boundary's durable receipt, including crash replay.
  stored=true;
  return{service,repository,native,projector,intent,updateTracking,channels,provider,logger};
}
describe('package reconciliation channel adoption',()=>{
  it('updates only tracking on a uniquely matched earlier fulfillment, with notifications disabled',async()=>{
    const f=fixture();const result=await f.service.execute(request);
    expect(f.updateTracking).toHaveBeenCalledWith(f.native,'gid://shopify/Fulfillment/1',{number:'NEW',company:'UPS'},false);
    expect(f.intent.mock.invocationCallOrder[0]).toBeLessThan(f.updateTracking.mock.invocationCallOrder[0]);
    expect(result.readbacks).toEqual([{physicalShipmentId:500,omsOrderId:10,channelId:36,fulfillmentId:'gid://shopify/Fulfillment/1',trackingNumber:'NEW',items:[{channelOrderLineId:'100',quantity:2}],observedAt:now.toISOString()}]);
    expect(f.native.request.mock.calls.every(([query])=>query.startsWith('query '))).toBe(true);
  });
  it('adopts an already-correct current fulfillment without any provider mutation',async()=>{
    const f=fixture({tracking:'NEW'});await f.service.execute(request);
    expect(f.updateTracking).not.toHaveBeenCalled();expect(f.intent).not.toHaveBeenCalled();expect(f.repository.completePackageReconciliation).toHaveBeenCalledOnce();
  });
  it('resumes after a successful tracking update whose response was lost without updating again',async()=>{
    const f=fixture({failAfterTracking:true});await expect(f.service.execute(request)).rejects.toThrow('timeout');
    expect(f.repository.completePackageReconciliation).not.toHaveBeenCalled();
    await f.service.execute(request);expect(f.updateTracking).toHaveBeenCalledOnce();expect(f.provider.load).not.toHaveBeenCalled();
    expect(f.repository.recordPackageReconciliationFailure).toHaveBeenCalledOnce();expect(f.repository.completePackageReconciliation).toHaveBeenCalledOnce();
  });
  it.each([{quantity:1},{tracking:'UNRELATED'},{duplicate:true}])('refuses mismatched quantities, unrelated tracking, and ambiguous fulfilled portions %j',async options=>{
    const f=fixture(options);await expect(f.service.execute(request)).rejects.toMatchObject({code:'CHANNEL_PACKAGE_MAPPING_UNPROVEN'});
    expect(f.updateTracking).not.toHaveBeenCalled();expect(f.repository.completePackageReconciliation).not.toHaveBeenCalled();
  });
  it('pins the originating channel account and rejects a changed replay intent',async()=>{
    const f=fixture({tracking:'NEW'});await f.service.execute(request);expect(f.channels.shopify).toHaveBeenCalledWith(36);
    await expect(f.service.execute({...request,sourceItemIds:[99]})).rejects.toMatchObject({code:'RECONCILIATION_REPLAY_CONFLICT'});
  });
});
