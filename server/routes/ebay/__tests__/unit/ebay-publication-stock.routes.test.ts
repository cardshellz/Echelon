import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { registerEbayPublicationStockRoutes } from "../../ebay-publication-stock.routes";
const {hasPermission}=vi.hoisted(()=>({hasPermission:vi.fn(async()=>true)}));
vi.mock("../../../../modules/identity",()=>({hasPermission}));
describe("retired manual eBay stock setup HTTP",()=>{
  let server:ReturnType<ReturnType<typeof express>["listen"]>,url:string;
  const getReceipt=vi.fn(async(_productId:number,_commandKey:string)=>null);
  beforeEach(async()=>{
    getReceipt.mockReset().mockResolvedValue(null);hasPermission.mockReset().mockResolvedValue(true);
    const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.defineProperty(req,"session",{value:{user:{id:"operator"}}});next();});
    registerEbayPublicationStockRoutes(app,{getReceipt});server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server.once("listening",resolve));
    url=`http://127.0.0.1:${(server.address()as AddressInfo).port}/api/ebay/listings/products/232/publication-readiness`;
  });
  afterEach(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
  it.each(["GET","POST"])("returns actionable retirement for %s without any owner writes",async method=>{
    const response=await fetch(url+(method==="POST"?"/apply":""),{method});expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({code:"EBAY_PUBLICATION_STOCK_APPLY_RETIRED",error:expect.stringContaining("Use Publish")});
    expect(getReceipt).not.toHaveBeenCalled();
  });
  it("preserves permission checks",async()=>{hasPermission.mockResolvedValue(false);expect((await fetch(url,{method:"GET"})).status).toBe(403);expect(getReceipt).not.toHaveBeenCalled();});
  it("keeps exact historical command lookup available",async()=>{
    const command="655ca747-20b9-4940-9c61-019baf1c11c1";expect((await fetch(`${url}/commands/${command}`)).status).toBe(404);
    expect(getReceipt).toHaveBeenCalledExactlyOnceWith(232,command);expect((await fetch(`${url}/commands/not-uuid`)).status).toBe(400);
  });
});
