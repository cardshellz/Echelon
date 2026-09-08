import { describe, expect, it, vi } from "vitest";
import type { Express, Request, Response } from "express";
import type { InboundTrackingService } from "../../inbound-tracking.service";
import { InboundTrackingError } from "../../inbound-tracking.domain";
vi.mock("../../inbound-tracking.runtime",()=>({getInboundTrackingService:vi.fn()}));
vi.mock("../../../../routes/middleware",()=>({requirePermission:vi.fn((resource:string,action:string)=>({resource,action}))}));
import { registerInboundTrackingRoutes } from "../../inbound-tracking.routes";
function setup(){
  const definitions=new Map<string,unknown[]>();
  const app={get:(path:string,...handlers:unknown[])=>definitions.set(`GET ${path}`,handlers),put:(path:string,...handlers:unknown[])=>definitions.set(`PUT ${path}`,handlers),post:(path:string,...handlers:unknown[])=>definitions.set(`POST ${path}`,handlers)};
  const service={read:vi.fn(),history:vi.fn(),save:vi.fn(),refresh:vi.fn()};
  registerInboundTrackingRoutes(app as unknown as Express,service as unknown as InboundTrackingService);
  const response={status:vi.fn(),json:vi.fn()}; response.status.mockReturnValue(response);
  const run=(route:string,request:unknown)=>(definitions.get(route)!.at(-1) as (req:Request,res:Response)=>Promise<void>)(request as Request,response as unknown as Response);
  return {definitions,service,response,run};
}
describe("inbound tracking HTTP boundaries",()=>{
  it("separates view and edit capabilities and has no external calls at registration",()=>{
    const {definitions,service}=setup();
    expect(definitions.get("GET /api/inbound-shipments/:id/tracking")?.[0]).toEqual({resource:"purchasing",action:"view"});
    expect(definitions.get("PUT /api/inbound-shipments/:id/tracking")?.[0]).toEqual({resource:"purchasing",action:"edit"});
    expect(definitions.get("POST /api/inbound-shipments/:id/tracking/:referenceId/refresh")?.[0]).toEqual({resource:"purchasing",action:"edit"});
    expect(service.refresh).not.toHaveBeenCalled();
  });
  it.each(["0","-1","1x","2147483648"])("rejects invalid shipment identifier %s",async(id)=>{
    const {run,response,service}=setup(); await run("GET /api/inbound-shipments/:id/tracking",{params:{id}});
    expect(response.status).toHaveBeenCalledWith(400); expect(service.read).not.toHaveBeenCalled();
  });
  it("uses the authenticated actor and returns queued refresh rather than claiming a live update",async()=>{
    const {run,response,service}=setup(); service.refresh.mockResolvedValue({referenceId:4,revision:1,queued:true});
    await run("POST /api/inbound-shipments/:id/tracking/:referenceId/refresh",{params:{id:"7",referenceId:"4"},body:{requestKey:"key"},session:{user:{id:"operator"}}});
    expect(service.refresh).toHaveBeenCalledWith(7,4,{requestKey:"key"},"operator"); expect(response.status).toHaveBeenCalledWith(202);
  });
  it("returns classified conflicts and hides unexpected error content",async()=>{
    const {run,response,service}=setup(); service.read.mockRejectedValue(new InboundTrackingError("TRACKING_SHIPMENT_NOT_FOUND","Shipment not found.",404));
    await run("GET /api/inbound-shipments/:id/tracking",{params:{id:"7"}}); expect(response.status).toHaveBeenCalledWith(404);
    const log=vi.spyOn(console,"error").mockImplementation(()=>{});
    try{service.read.mockRejectedValue(new Error("credential-secret"));await run("GET /api/inbound-shipments/:id/tracking",{params:{id:"7"}});expect(response.status).toHaveBeenCalledWith(500);expect(JSON.stringify(log.mock.calls)).not.toContain("credential-secret");expect(JSON.stringify(response.json.mock.calls)).not.toContain("credential-secret");}finally{log.mockRestore();}
  });
});
