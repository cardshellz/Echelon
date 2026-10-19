import express from "express";
import {createServer,request as httpRequest,type Server} from "node:http";
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
    registerCostReportingRoutes(app,service as never);
    server=createServer(app);
    await new Promise<void>((resolve,reject) => {server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
    const address=server.address();
    if (!address || typeof address === "string") throw new Error("Reporting test server has no loopback address");
    origin=`http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => {await new Promise<void>((resolve,reject) => {server.closeAllConnections();server.close((error) => error ? reject(error) : resolve());});});
  // Fetch blocks some OS-assigned ports before reaching Express. These route
  // tests require actual HTTP transport, not browser port-policy enforcement.
  const request=(path:string,options:{method?:string;headers?:Record<string,string>;body?:string}={}) => new Promise<{status:number;headers:Headers}>((resolve,reject) => {
    const url=new URL(path,origin);
    const request=httpRequest(url,{
      method:options.method ?? "GET",agent:false,
      headers:{...options.headers,...(options.body === undefined ? {} : {"Content-Length":String(Buffer.byteLength(options.body))})},
    },(response) => {
      const headers=new Headers();
      for (const [name,value] of Object.entries(response.headers)) {
        if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) headers.append(name,item);
      }
      response.on("error",reject);
      response.on("end",() => {
        if (response.statusCode === undefined) reject(new Error(`Missing HTTP status from ${url}`));
        else resolve({status:response.statusCode,headers});
      });
      response.resume();
    });
    request.on("error",(error) => reject(new Error(`Reporting test HTTP request ${options.method ?? "GET"} ${url} failed: ${error.message}`)));
    request.setTimeout(5000,() => request.destroy(new Error("Reporting test request timed out after 5000 ms")));
    request.end(options.body);
  });
  const get=(path:string) => request(path,{headers:{"X-Test-Actor":"reviewer"}});
  const post=(key="reviewed-intent") => request(`/api/purchase-orders/10/cost-reporting/${id}/retry`,{method:"POST",headers:{"X-Test-Actor":"reviewer","Content-Type":"application/json",...(key ? {"Idempotency-Key":key} : {})},body:JSON.stringify({expectedAttemptCount:2,reason:"Receiver verified"})});
  it.each(["0","-1","1e2","2147483648","9007199254740991"])("rejects a purchase ID outside PostgreSQL integer scope: %s",async (purchaseId) => {
    expect((await get(`/api/purchase-orders/${purchaseId}/cost-reporting`)).status).toBe(400);expect(service.status).not.toHaveBeenCalled();
  });
  it("requires authenticated view and purchasing approval for retry",async () => {
    expect((await request("/api/purchase-orders/10/cost-reporting")).status).toBe(401);
    permission.mockResolvedValue(false);expect((await post()).status).toBe(403);expect(service.retry).not.toHaveBeenCalled();expect(permission).toHaveBeenCalledWith("reviewer","purchasing","approve");
  });
  it("requires a retained command key and carries the exact actor/retry version",async () => {
    expect((await post("")).status).toBe(400);expect(service.retry).not.toHaveBeenCalled();
    service.retry.mockResolvedValue({deliveryId:id,state:"queued",replayed:true});const response=await post();expect(response.status).toBe(200);expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.retry).toHaveBeenCalledWith({purchaseOrderId:10,deliveryId:id,key:"reviewed-intent",actor:"reviewer",command:{expectedAttemptCount:2,reason:"Receiver verified"}});
  });
});
