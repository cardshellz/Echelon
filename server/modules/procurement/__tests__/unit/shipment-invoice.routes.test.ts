import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({execute:vi.fn(),permission:vi.fn(),log:vi.fn()}));
vi.mock("../../../identity",()=>({hasPermission:mocks.permission}));
vi.mock("../../../../platform/observability",()=>({logger:{error:mocks.log}}));
vi.mock("../../../../platform/commands/command-results.repository",()=>({financialCommandRepository:{}}));
vi.mock("../../ap-ledger.service",()=>({}));
vi.mock("../../shipment-invoice.commands",async original=>({...await original<typeof import("../../shipment-invoice.commands")>(),createShipmentInvoiceCommands:()=>({execute:mocks.execute})}));
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";
import { hashShipmentInvoiceCommandIdentity, shipmentInvoiceCommandScope, SHIPMENT_INVOICE_COMMAND_PRINCIPAL } from "../../shipment-invoice.commands";
import { registerShipmentInvoiceRoutes } from "../../shipment-invoice.routes";
const key="freight-create-http-1", body={vendorId:6,invoiceNumber:"F-1",costRowIds:[31]};
describe("shipment invoice HTTP recovery boundary",()=>{
  let server:Server,base:string;
  beforeAll(async()=>{
    const app=express();app.use(express.json());app.use((req,_res,next)=>{
      const actor=req.headers["x-test-actor"];req.session=(typeof actor==="string"?{user:{id:actor}}:{}) as Request["session"];next();
    });registerShipmentInvoiceRoutes(app);server=createServer(app);
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",()=>{server.off("error",reject);resolve();});});
    base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async()=>{if(server)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
  beforeEach(()=>{vi.clearAllMocks();mocks.permission.mockResolvedValue(true);mocks.execute.mockResolvedValue({commandId:1,replayed:false,terminalState:"succeeded",httpStatus:200,body:{invoiceId:5}});});
  function post(path="/api/inbound-shipments/1/create-invoice",headers:Record<string,string>={"Idempotency-Key":key},actor:string|null="operator"){
    const payload=JSON.stringify(body);
    return new Promise<{status:number;body:Record<string,unknown>;headers:Record<string,unknown>}>((resolve,reject)=>{
      const req=httpRequest(new URL(path,base),{method:"POST",agent:false,headers:{"content-type":"application/json","content-length":Buffer.byteLength(payload),...(actor===null?{}:{"x-test-actor":actor}),...headers}},res=>{
        let text="";res.setEncoding("utf8");res.on("data",chunk=>text+=chunk);res.on("error",reject);res.on("end",()=>{try{resolve({status:res.statusCode??0,body:JSON.parse(text),headers:res.headers});}catch(error){reject(error);}});
      });req.setTimeout(5000,()=>req.destroy(new Error("HTTP invoice fixture timed out")));req.on("error",reject);req.end(payload);
    });
  }
  it("requires authenticated purchasing edit permission before executing",async()=>{
    expect((await post(undefined,undefined,null)).status).toBe(401);expect(mocks.execute).not.toHaveBeenCalled();
    mocks.permission.mockResolvedValueOnce(false);expect((await post()).status).toBe(403);expect(mocks.permission).toHaveBeenCalledWith("operator","purchasing","edit");expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("passes unchanged input and session operator in one global durable identity",async()=>{
    const result=await post();expect(result.status).toBe(200);expect(result.headers["idempotency-replayed"]).toBe("false");
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(1,body,"operator",{...shipmentInvoiceCommandScope(),actorType:"service",actorId:SHIPMENT_INVOICE_COMMAND_PRINCIPAL,contractVersion:1,idempotencyKey:key,requestHash:hashShipmentInvoiceCommandIdentity({shipmentId:1,body,actorId:"operator"})});
  });
  it.each(["0","-1","1x","2147483648"])("rejects invalid shipment%s before command identity",async id=>{expect((await post(`/api/inbound-shipments/${id}/create-invoice`)).status).toBe(400);expect(mocks.execute).not.toHaveBeenCalled();});
  it("rejects query parameters and missing or conflicting keys without definitive rejection marker",async()=>{
    for(const response of [await post("/api/inbound-shipments/1/create-invoice?extra=1"),await post(undefined,{}),await post(undefined,{"Idempotency-Key":key,"X-Idempotency-Key":"different-key"})]){
      expect(response.status).toBe(400);expect(response.body).not.toHaveProperty("commandOutcome");
    }expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("preserves exact saved rejection status and acknowledgement on replay",async()=>{
    const rejected={code:"SOURCE_BILLED",error:"Already billed",commandOutcome:"rejected",shipmentId:1,actorId:"operator",idempotencyKey:key};
    mocks.execute.mockResolvedValueOnce({httpStatus:409,replayed:true,terminalState:"rejected",body:rejected});const result=await post();expect(result).toMatchObject({status:409,body:rejected});expect(result.headers["idempotency-replayed"]).toBe("true");
  });
  it("keeps transient errors unresolved and hides database details",async()=>{
    mocks.execute.mockRejectedValueOnce(new Error("private-db-credential"));const result=await post();expect(result.status).toBe(503);expect(result.body).not.toHaveProperty("commandOutcome");expect(JSON.stringify(result)).not.toContain("private-db-credential");expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("private-db-credential");
  });
  it("preserves command retry headers without inventing rejection",async()=>{
    mocks.execute.mockRejectedValueOnce(new FinancialCommandError("Still running",409,"FINANCIAL_COMMAND_IN_PROGRESS",undefined,{"Retry-After":"2"}));const result=await post();expect(result.status).toBe(409);expect(result.headers["retry-after"]).toBe("2");expect(result.body).not.toHaveProperty("commandOutcome");
  });
});
