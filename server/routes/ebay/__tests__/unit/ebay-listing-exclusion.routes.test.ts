import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { registerEbayListingExclusionRoutes } from "../../ebay-listing-exclusion.routes";
import type { EbayListingExclusionService } from "../../../../modules/channels/ebay-listing-exclusion";
import { EbayListingSyncError } from "../../../../modules/channels/ebay-listing-sync.domain";
import type { EbayProductExclusionResult } from "@shared/types/ebay-listing-exclusion";
const {hasPermission}=vi.hoisted(()=>({hasPermission:vi.fn(async(_user:string,_resource:string,_action:string)=>true)}));
vi.mock("../../../../modules/identity",()=>({hasPermission}));
const commandKey="655ca747-20b9-4940-9c61-019baf1c11c1";
const now="2026-10-12T12:00:00.000Z";
const result:EbayProductExclusionResult={success:true,productId:3,excluded:true,commandKey,replayed:false,remoteAction:"queued_withdrawal",
  job:{id:commandKey,kind:"sync",operation:"withdraw",productId:3,state:"queued",code:null,message:null,nextAttemptAt:now,updatedAt:now}};
describe("permissioned durable eBay product exclusion HTTP boundary",()=>{
  let server:ReturnType<ReturnType<typeof express>["listen"]>;let url:string;let session:{user?:{id:string}};let service:EbayListingExclusionService;
  beforeEach(async()=>{hasPermission.mockReset().mockResolvedValue(true);vi.spyOn(console,"error").mockImplementation(()=>{});session={user:{id:"operator"}};
    service={set:vi.fn(async()=>structuredClone(result)),get:vi.fn(async()=>({...structuredClone(result),replayed:true}))};
    const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as unknown as {session:typeof session}).session=session;next();});
    registerEbayListingExclusionRoutes(app,service);server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ebay/product-exclusion/3`;
  });
  afterEach(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));vi.restoreAllMocks();});
  const put=(url:string,body:unknown)=>fetch(url,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  it("returns the queued withdrawal and records only the session actor",async()=>{const response=await put(url,{excluded:true,commandKey});expect(response.status).toBe(200);expect(await response.json()).toEqual(result);expect(service.set).toHaveBeenCalledExactlyOnceWith(3,{excluded:true,commandKey},"operator");});
  it("blocks unauthenticated and unpermitted calls before any owner or database work",async()=>{session={};expect((await put(url,{excluded:true,commandKey})).status).toBe(401);expect((await fetch(`${url}/commands/${commandKey}`)).status).toBe(401);
    session={user:{id:"operator"}};hasPermission.mockResolvedValue(false);expect((await put(url,{excluded:true,commandKey})).status).toBe(403);expect((await fetch(`${url}/commands/${commandKey}`)).status).toBe(403);expect(service.set).not.toHaveBeenCalled();expect(service.get).not.toHaveBeenCalled();});
  it.each([{excluded:true},{excluded:"true",commandKey},{excluded:true,commandKey,offerId:"foreign"},{excluded:true,commandKey,actor:"injected"}])("validates intent and rejects untrusted extra fields %j",async body=>{expect((await put(url,body)).status).toBe(400);expect(service.set).not.toHaveBeenCalled();});
  it("looks up the exact receipt for recovery without reading or mutating eBay",async()=>{const response=await fetch(`${url}/commands/${commandKey}`);expect(response.headers.get("cache-control")).toBe("no-store");expect(await response.json()).toMatchObject({commandKey,replayed:true});expect(service.get).toHaveBeenCalledExactlyOnceWith(3,commandKey);expect(service.set).not.toHaveBeenCalled();});
  it("preserves the blocking job reference when reinclude is unsafe",async()=>{vi.mocked(service.set).mockRejectedValue(Object.assign(new EbayListingSyncError("EBAY_WITHDRAWAL_IN_PROGRESS","Wait for this saved withdrawal."),{jobId:commandKey}));const response=await put(url,{excluded:false,commandKey});expect(response.status).toBe(409);expect(await response.json()).toMatchObject({code:"EBAY_WITHDRAWAL_IN_PROGRESS",jobId:commandKey});});
  it("does not expose database errors or claim an uncertain receipt failed permanently",async()=>{vi.mocked(service.set).mockRejectedValue(new Error("postgres://secret:password internal SQL"));const response=await put(url,{excluded:true,commandKey});expect(response.status).toBe(500);const text=await response.text();expect(text).not.toContain("password");expect(text).toContain("saved status");});
  it("returns selection-busy with instructions to retry the original exclusion request",async()=>{
    vi.mocked(service.set).mockRejectedValue(new Error("private SQL",{cause:{code:"55P03",message:"PUBLICATION_SELECTION_BUSY"}}));
    const response=await put(url,{excluded:true,commandKey});expect(response.status).toBe(409);
    const body=await response.json();expect(body).toMatchObject({code:"PUBLICATION_SELECTION_BUSY",retryable:true,
      issue:{action:{kind:"edit_listing"},nextStep:expect.stringContaining("original request reference")}});
    expect(JSON.stringify(body)).not.toContain("private SQL");
  });
});
