import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCustomerReturnGuestRoutes, type GuestReturnRouteDependencies } from "../../interfaces/http/customer-return-guest.routes";
import { CustomerReturnCustomerAuthService, CustomerReturnCustomerAccessError } from "../../application/customer-return-customer-auth.service";
import { RETURN_GUEST_PROXY_API } from "@shared/returns/customer-return-guest.contract";

const now=new Date("2026-11-01T12:00:00Z"),shop="fixture.myshopify.com";
const config={storageSecret:"s".repeat(64),publicOrigin:"https://returns.test",shops:{[shop]:{proxyUrl:"https://store.test/apps/echelon-returns",shopifySecret:"synthetic-proxy-secret"}}};
function signed(overrides:Record<string,string>={}) {
  const fields={shop,logged_in_customer_id:"",path_prefix:"/apps/echelon-returns",timestamp:String(now.getTime()/1000),...overrides};
  const message=Object.entries(fields).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>`${key}=${value}`).join("");
  return new URLSearchParams({...fields,signature:createHmac("sha256",config.shops[shop].shopifySecret).update(message).digest("hex")}).toString();
}
describe("signed Shopify guest-return gateway",()=>{
  let server:Server,base:string;
  const purchase={channelId:2,shopDomain:shop,omsOrderId:10,externalOrderId:"1001",externalCustomerId:null,email:"guest@example.test",
    verifiedPurchase:{email:"guest@example.test",customerId:null}};
  const proof={challengeId:"c1d149b8-72ce-47e9-8b62-4a9056473a03",browserKey:"b".repeat(43),grant:"g".repeat(43)};
  const lookup=vi.fn(async()=>({challengeId:proof.challengeId,expiresAt:"2026-11-01T12:10:00.000Z"}));
  const authorize=vi.fn(async(_channel:number,input:unknown)=>{
    if(JSON.stringify(input)!==JSON.stringify(proof)) throw new CustomerReturnCustomerAccessError("RETURN_GUEST_VERIFICATION_REQUIRED","Verify your email.",401);
    return {purchase,session:{}};
  });
  const queueLabels=vi.fn(async()=>({phase:"queued"}));
  const order=vi.fn(async(id:number)=>{
    if(id!==10) throw new CustomerReturnCustomerAccessError("CUSTOMER_RETURN_ORDER_UNAVAILABLE","This order is unavailable.",404);
    return {omsOrderId:10};
  });
  const services=vi.fn(async()=>({orders:{order,choices:async()=>({orders:[{omsOrderId:10}],nextBeforeOmsOrderId:null})},operations:{queueLabels}}));
  beforeEach(async()=>{
    vi.clearAllMocks();
    const auth=new CustomerReturnCustomerAuthService({config,challenges:{create:vi.fn(),consume:vi.fn()},
      shops:async()=>[{channelId:2,connectionId:4,shopDomain:shop,displayName:"Synthetic"}],now:()=>now,randomState:()=>"a".repeat(43)});
    const app=express();app.use(express.json({limit:"64kb"}));
    registerCustomerReturnGuestRoutes(app,{context:async()=>({config,auth}),service:async()=>({lookup,authorize}),returns:services,
      staging:()=>({themeId:"174740308127",shops:{[shop]:{enabled:true}}})} as unknown as GuestReturnRouteDependencies);
    server=await new Promise<Server>(resolve=>{const listener=app.listen(0,"127.0.0.1",()=>resolve(listener));});
    base=`http://127.0.0.1:${(server.address() as AddressInfo).port}${RETURN_GUEST_PROXY_API}`;
  });
  afterEach(async()=>{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
  function request(body:Record<string,unknown>,query=signed(),origin="https://store.test") {
    return fetch(`${base}?${query}`,{method:"POST",headers:{"Content-Type":"application/json",Origin:origin,"X-Customer-Account":"1"},
      body:JSON.stringify({themeId:"174740308127",...body})});
  }
  it("allows a genuinely signed guest to start email verification without a fabricated customer ID",async()=>{
    expect((await request({action:"lookup",input:{orderReference:"1001"}})).status).toBe(200);
    expect(lookup).toHaveBeenCalledWith(2,shop,{orderReference:"1001"});expect(authorize).not.toHaveBeenCalled();expect(services).not.toHaveBeenCalled();
  });
  it("rejects tampered, expired and foreign-shop proof before purchase lookup",async()=>{
    for(const query of [signed().replace("signature=","signature=f"),signed({timestamp:"1"}),signed({shop:"other.myshopify.com"})])
      expect((await request({action:"lookup",input:{}},query)).status).not.toBe(200);
    expect(lookup).not.toHaveBeenCalled();expect(services).not.toHaveBeenCalled();
  });
  it("requires the configured theme, exact storefront origin and guest proof",async()=>{
    expect((await request({action:"lookup",input:{}},signed(),"https://evil.test")).status).toBe(403);
    expect((await request({themeId:"999",action:"lookup",input:{}})).status).toBe(403);
    expect((await request({action:"returns",proof:{...proof,grant:"x".repeat(43)},input:{method:"GET",path:"/returns/orders/10"}})).status).toBe(401);
    expect(services).not.toHaveBeenCalled();
  });
  it("reuses the canonical order/label dispatcher and keeps cross-order access denied",async()=>{
    expect((await request({action:"returns",proof,input:{method:"GET",path:"/returns/orders/10"}})).status).toBe(200);
    expect(services).toHaveBeenCalledWith(purchase);expect(order).toHaveBeenCalledWith(10);
    expect((await request({action:"returns",proof,input:{method:"GET",path:"/returns/orders/11"}})).status).toBe(404);
    const body={idempotencyKey:"cccf2cd9-5c6e-48c2-a572-7d6c3b9d7064"};
    expect((await request({action:"returns",proof,input:{method:"POST",path:"/returns/orders/10/label-requests",body}})).status).toBe(200);
    expect(queueLabels).toHaveBeenCalledWith(10,body);
    expect((await request({action:"returns",proof,input:{method:"GET",path:"/returns/order-options"}})).status).toBe(200);
    expect((await request({action:"returns",proof,input:{method:"POST",path:"/order-edits/orders/10/commit"}})).status).toBe(400);
  });
});
