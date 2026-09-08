import express from "express";
import {createServer,type Server} from "node:http";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
const permission=vi.hoisted(() => vi.fn());
vi.mock("../../../../modules/identity",() => ({hasPermission:permission}));
import {registerCostReportingRoutes} from "../../cost-reporting.routes";

describe("purchase reporting HTTP authority",() => {
  let server:Server,origin:string;
  const service={status:vi.fn(),retry:vi.fn()};
  const id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  beforeEach(async () => {
    vi.clearAllMocks();permission.mockResolvedValue(true);service.status.mockResolvedValue({purchaseOrderId:10});
    const app=express();app.use(express.json());app.use((req,_res,next) => {req.session={user:req.get("X-Test-Actor") ? {id:req.get("X-Test-Actor")} : undefined} as never;next();});
    registerCostReportingRoutes(app,service as never);server=createServer(app);await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  });
  afterEach(async () => {await new Promise<void>((resolve,reject) => {server.closeAllConnections();server.close((error) => error ? reject(error) : resolve());});});
  const get=(path:string) => fetch(origin+path,{headers:{"X-Test-Actor":"reviewer"}});
  const post=(key="reviewed-intent") => fetch(`${origin}/api/purchase-orders/10/cost-reporting/${id}/retry`,{method:"POST",headers:{"X-Test-Actor":"reviewer","Content-Type":"application/json",...(key ? {"Idempotency-Key":key} : {})},body:JSON.stringify({expectedAttemptCount:2,reason:"Receiver verified"})});
  it.each(["0","-1","1e2","2147483648","9007199254740991"])("rejects a purchase ID outside PostgreSQL integer scope: %s",async (purchaseId) => {
    expect((await get(`/api/purchase-orders/${purchaseId}/cost-reporting`)).status).toBe(400);expect(service.status).not.toHaveBeenCalled();
  });
  it("requires authenticated view and purchasing approval for retry",async () => {
    expect((await fetch(`${origin}/api/purchase-orders/10/cost-reporting`)).status).toBe(401);
    permission.mockResolvedValue(false);expect((await post()).status).toBe(403);expect(service.retry).not.toHaveBeenCalled();expect(permission).toHaveBeenCalledWith("reviewer","purchasing","approve");
  });
  it("requires a retained command key and carries the exact actor/retry version",async () => {
    expect((await post("")).status).toBe(400);expect(service.retry).not.toHaveBeenCalled();
    service.retry.mockResolvedValue({deliveryId:id,state:"queued",replayed:true});const response=await post();expect(response.status).toBe(200);expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.retry).toHaveBeenCalledWith({purchaseOrderId:10,deliveryId:id,key:"reviewed-intent",actor:"reviewer",command:{expectedAttemptCount:2,reason:"Receiver verified"}});
  });
});
