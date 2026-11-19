import { describe,expect,it,vi } from 'vitest';
import { createShipStationPackageReconciliationClient } from '../../shipstation-package-reconciliation.client';
import type { PackageReconciliationSnapshot } from '../../../oms/package-reconciliation.repository';
const at='2026-09-17T14:00:00.000Z';
const snapshot={sources:[{id:1,shipment_id:1,qty:3,provider:'shopify',purpose:'customer_fulfillment',sku:'SKU-A'}],evidence:[1,2].map(id=>({label:{id:String(id),provider_label_id:String(10+id),provider_order_id:'20',provider_order_key:'root',tracking_number:`TRACK${id}`,label_status:id===1?'voided':'active'}}))} as unknown as PackageReconciliationSnapshot;
function fixture(options:{unknownPackage?:boolean;badSku?:boolean;badTotal?:boolean;missingOrder?:boolean;throttle?:boolean}={}){
  let throttled=false;const sleep=vi.fn(async()=>{});
  const request=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    expect(init?.method).toBe('GET');const url=new URL(String(input));
    if(options.throttle&&!throttled){throttled=true;return new Response('',{status:429,headers:{'retry-after':'1'}});}
    if(url.pathname==='/orders/20')return options.missingOrder?new Response('',{status:404}):Response.json({orderId:20,orderKey:'root',advancedOptions:{mergedIds:[30],parentId:null}});
    if(url.searchParams.has('shipmentId')){
      const id=Number(url.searchParams.get('shipmentId'));return Response.json({shipments:[{shipmentId:id,orderId:20,orderKey:'root',trackingNumber:`TRACK${id-10}`,
        voided:id===11,isReturnLabel:false,carrierCode:'ups',serviceCode:'ups_ground',shipTo:{name:'DO-NOT-RETAIN'},
        shipmentItems:[{lineItemKey:'wms-item-1',sku:options.badSku?'WRONG':'SKU-A',quantity:id===11?1:3}]}]});
    }
    // The V1 order list mutates old label contents after a merge. It may prove
    // label membership, but the exact shipment endpoint must own contents.
    return Response.json({page:1,pages:1,total:options.badTotal?3:options.unknownPackage?3:2,shipments:[{shipmentId:11,shipmentItems:[{lineItemKey:'wms-item-1',quantity:3}]},{shipmentId:12},...(options.unknownPackage?[{shipmentId:13}]:[])]});
  });
  const client=createShipStationPackageReconciliationClient({apiKey:'test-key',apiSecret:'test-secret',fetch:request as typeof fetch,
    clock:()=>new Date(at),sleep,minimumIntervalMs:0});return{client,request,sleep};
}
describe('ShipStation current-package evidence client',()=>{
  it('uses exact manifests instead of a merged order list, records explicit merge evidence, and retains no recipient data',async()=>{
    const f=fixture();const result=await f.client.load(snapshot);
    expect(result.labels.map(label=>label.contents)).toEqual([[{sourceItemId:1,quantity:1}],[{sourceItemId:1,quantity:3}]]);
    expect(result.relationships).toMatchObject([{providerOrderId:'20',mergedProviderOrderIds:['30'],parentProviderOrderId:null}]);
    expect(JSON.stringify(result)).not.toContain('DO-NOT-RETAIN');expect(JSON.stringify(result)).not.toContain('test-secret');
  });
  it.each([{unknownPackage:true},{badSku:true},{badTotal:true}])('refuses undiscovered packages, changed source identities, or incomplete listings %j',async options=>{
    await expect(fixture(options).client.load(snapshot)).rejects.toThrow();
  });
  it('does not confuse a merged-away order resource with an absent package',async()=>{
    const result=await fixture({missingOrder:true}).client.load(snapshot);expect(result.labels).toHaveLength(2);expect(result.relationships).toEqual([]);
  });
  it('bounds retry after rate limiting and never changes the GET operation',async()=>{
    const f=fixture({throttle:true});await f.client.load(snapshot);expect(f.sleep).toHaveBeenCalledWith(1000);
  });
});
