import { describe, expect, it, vi } from "vitest";
import { ShopifyGuestReturnPurchaseGateway } from "../../infrastructure/customer-return-guest-shopify.gateway";
import type { Pool } from "pg";

function fixture() {
  const local = { id: 10, external_order_id: "1001", external_customer_id: "9001", external_order_number: "#1001" };
  const remote = { id: "gid://shopify/Order/1001", name: "#1001", email: "guest@example.test",
    customer: { id: "gid://shopify/Customer/9001", email: "guest@example.test", state: "DISABLED" } };
  const database = { query: vi.fn(async (_query: string, _values?: unknown[]) => ({ rows:[local] })) };
  let observed: unknown = remote;
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const input=JSON.parse(String(init?.body));
    return Response.json({data: input.query.includes("mutation") ? {customerGenerateAccountActivationUrl:{ accountActivationUrl:"https://store.test/account/activate/9001/token",userErrors:[] }}
      : {shop:{myshopifyDomain:"test.myshopify.com"},order:observed}}, {headers:{"X-Shopify-API-Version":"2026-07"}});
  });
  const reader = new ShopifyGuestReturnPurchaseGateway({ database: database as unknown as Pick<Pool,"query">,
    connection: async channelId=>({id:1,channelId,shopDomain:"test.myshopify.com",accessToken:"synthetic",apiVersion:"2026-10",shopifyLocationId:null}),
    request,storefrontOrigin:()=>"https://store.test" });
  const purchase={channelId:1,shopDomain:"test.myshopify.com",omsOrderId:10,externalOrderId:"1001",externalCustomerId:"9001",email:remote.email,verifiedPurchase:{email:remote.email,customerId:remote.customer.id}};
  return {reader,request,database,local,remote,purchase,setRemote:(value:unknown)=>{observed=value;}};
}
describe("Shopify guest purchase and optional activation linkage",()=>{
  it("binds order number to one local order, then reads that exact Shopify ID",async()=>{
    const f=fixture(); expect(await f.reader.find(1,"test.myshopify.com","1001","GUEST@example.test")).toEqual(f.purchase);
    expect(f.database.query.mock.calls[0][1]).toEqual([1,expect.arrayContaining(["1001","#1001"])]);
    expect(JSON.parse(String(f.request.mock.calls[0][1]?.body)).variables).toEqual({id:"gid://shopify/Order/1001"});
    expect(await f.reader.current(f.purchase)).toBe(true);
    expect(f.request.mock.calls.every(([,init])=>!String(init?.body).includes("mutation"))).toBe(true);
  });
  it("refuses ambiguous local aliases and mismatched email, order ID, shop or customer ID",async()=>{
    const f=fixture(); f.database.query.mockResolvedValueOnce({rows:[f.local,f.local]});
    expect(await f.reader.find(1,"test.myshopify.com","1001",f.remote.email)).toBeNull(); expect(f.request).not.toHaveBeenCalled();
    expect(await f.reader.find(1,"test.myshopify.com","1001","wrong@example.test")).toBeNull();
    f.setRemote({...f.remote,customer:{...f.remote.customer,id:"gid://shopify/Customer/9002"}});
    expect(await f.reader.current(f.purchase)).toBe(false);
    f.setRemote({...f.remote,id:"gid://shopify/Order/1002"});
    await expect(f.reader.current(f.purchase)).rejects.toMatchObject({code:"RETURN_GUEST_PURCHASE_UNAVAILABLE"});
  });
  it("passes the purchase's existing customer ID to Shopify activation; never creates or reassigns",async()=>{
    const f=fixture(); expect(await f.reader.account(f.purchase)).toMatchObject({kind:"activate"});
    const mutations=f.request.mock.calls.map(([,init])=>JSON.parse(String(init?.body))).filter(input=>input.query.includes("mutation"));
    expect(mutations).toEqual([{query:expect.stringContaining("customerGenerateAccountActivationUrl"),variables:{id:"gid://shopify/Customer/9001"}}]);
    expect(mutations[0].query).not.toMatch(/customerCreate|orderUpdate/);
  });
  it("reuses the activation URL on retry and offers sign-in once Shopify reports activation complete",async()=>{
    const f=fixture();const first=await f.reader.account(f.purchase);
    expect(await f.reader.account(f.purchase,first)).toEqual(first);
    f.setRemote({...f.remote,customer:{...f.remote.customer,state:"ENABLED"}});
    expect(await f.reader.account(f.purchase,first)).toMatchObject({kind:"sign_in"});
    expect(f.request.mock.calls.filter(([,init])=>String(init?.body).includes("mutation"))).toHaveLength(1);
  });
  it("accepts a verified Shopify purchase even when the historical local customer link is missing",async()=>{
    const f=fixture();f.local.external_customer_id=null as unknown as string;
    const purchase=await f.reader.find(1,"test.myshopify.com","1001",f.remote.email);
    expect(purchase).toMatchObject({externalCustomerId:null,verifiedPurchase:{email:f.remote.email,customerId:f.remote.customer.id}});
    expect(await f.reader.current(purchase!)).toBe(true);
    expect(await f.reader.account(purchase!)).toMatchObject({kind:"activate"});
    expect(JSON.parse(String(f.request.mock.calls.filter(([,init])=>String(init?.body).includes("mutation")).at(-1)![1]?.body)).variables).toEqual({id:f.remote.customer.id});
  });
  it("uses the Shopify customer for activation even when the imported customer link is stale",async()=>{
    const f=fixture();f.local.external_customer_id="9002";
    const purchase=await f.reader.find(1,"test.myshopify.com","1001",f.remote.email);
    expect(purchase).toMatchObject({externalCustomerId:"9002",verifiedPurchase:{customerId:"gid://shopify/Customer/9001"}});
    expect(await f.reader.current(purchase!)).toBe(true);
    await f.reader.account(purchase!);
    expect(JSON.parse(String(f.request.mock.calls.filter(([,init])=>String(init?.body).includes("mutation")).at(-1)![1]?.body)).variables).toEqual({id:"gid://shopify/Customer/9001"});
  });
  it("uses sign-in for enabled customers and registration for unattached purchases",async()=>{
    const f=fixture();f.setRemote({...f.remote,customer:{...f.remote.customer,state:"ENABLED"}});
    expect(await f.reader.account(f.purchase)).toMatchObject({kind:"sign_in",url:expect.stringContaining("/account/login")});
    f.setRemote({...f.remote,customer:null});f.local.external_customer_id=null as unknown as string;
    const purchase={...f.purchase,externalCustomerId:null,verifiedPurchase:{email:f.remote.email,customerId:null}};
    expect(await f.reader.find(1,"test.myshopify.com","1001",f.remote.email)).toEqual(purchase);
    expect(await f.reader.account(purchase)).toEqual({kind:"register",url:"https://store.test/account/register"});
    expect(f.request.mock.calls.every(([,init])=>!String(init?.body).includes("mutation"))).toBe(true);
  });
  it("does not activate an account whose email changed and does not expose provider errors",async()=>{
    const f=fixture();f.setRemote({...f.remote,customer:{...f.remote.customer,email:"other@example.test"}});
    await expect(f.reader.account(f.purchase)).rejects.toMatchObject({code:"RETURN_GUEST_ACCOUNT_EMAIL_CHANGED"});
    f.request.mockResolvedValueOnce(Response.json({errors:[{message:"private provider diagnostic"}]}));
    await expect(f.reader.current(f.purchase)).rejects.toMatchObject({message:"We couldn't verify the purchase right now. Please try again."});
  });
  it("withholds the activation capability if Shopify changes customer email during generation",async()=>{
    const f=fixture(),headers={"X-Shopify-API-Version":"2026-07"};
    f.request.mockResolvedValueOnce(Response.json({data:{shop:{myshopifyDomain:"test.myshopify.com"},order:f.remote}},{headers}));
    f.request.mockImplementationOnce(async()=>{
      f.setRemote({...f.remote,customer:{...f.remote.customer,email:"changed@example.test"}});
      return Response.json({data:{customerGenerateAccountActivationUrl:{accountActivationUrl:"https://store.test/account/activate/9001/token",userErrors:[]}}},{headers});
    });
    await expect(f.reader.account(f.purchase)).rejects.toMatchObject({code:"RETURN_GUEST_PURCHASE_UNAVAILABLE"});
  });
});
