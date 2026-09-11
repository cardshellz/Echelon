import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryOpeningCaptureRoutes } from "../../interfaces/http/inventory-opening-capture.routes";
import { InventoryCutoverOpeningError } from "../../application/inventory-cutover-opening.service";
const {hasPermission}=vi.hoisted(()=>({hasPermission:vi.fn(async()=>true)}));
vi.mock("../../../identity",()=>({hasPermission}));
const id="0f1b4b41-6cad-4caa-a3dd-d591179a6d84";
const status={id,state:"queued",stage:"queued",createdAt:"2026-09-10T00:00:00Z",completedAt:null,chunkCount:0,errorCode:null};
describe("capture queue authenticated HTTP boundary",()=>{
  let server:http.Server,root:string,user:{id:string}|undefined;
  let jobs:{enqueue:ReturnType<typeof vi.fn>;status:ReturnType<typeof vi.fn>;chunk:ReturnType<typeof vi.fn>};
  beforeEach(async()=>{
    user={id:"alice"}; hasPermission.mockResolvedValue(true);
    jobs={enqueue:vi.fn().mockResolvedValue(status),status:vi.fn().mockResolvedValue(status),chunk:vi.fn().mockResolvedValue({captureId:id,index:0,text:"{}"})};
    const app=express();app.use(express.json());
    app.use((req,_res,next)=>{Object.defineProperty(req,"session",{value:{user}});next();});
    registerInventoryOpeningCaptureRoutes(app,jobs);
    server=http.createServer(app);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    root=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/inventory-planning/admin/cutover-opening/captures`;
  });
  afterEach(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));vi.restoreAllMocks();});
  const post=(url:string,body:unknown)=>fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  it("returns202 after enqueue and serves bounded status/chunks under the session actor",async()=>{
    const queued=await post(root,{idempotencyKey:id});expect(queued.status).toBe(202);
    expect(queued.headers.get("cache-control")).toBe("no-store");
    expect(await queued.json()).toEqual(status);expect(jobs.enqueue).toHaveBeenCalledWith("alice",id);
    expect((await fetch(`${root}/${id}`)).status).toBe(200);
    expect((await fetch(`${root}/${id}/chunks/0`)).status).toBe(200);
    expect(jobs.chunk).toHaveBeenCalledWith("alice",id,0);
  });
  it.each([401,403])("rejects every endpoint for denied access %s",async code=>{
    if(code===401)user=undefined;else hasPermission.mockResolvedValue(false);
    expect((await post(root,{idempotencyKey:id})).status).toBe(code);
    expect((await fetch(`${root}/${id}`)).status).toBe(code);
    expect((await fetch(`${root}/${id}/chunks/0`)).status).toBe(code);
    expect(jobs.enqueue).not.toHaveBeenCalled();expect(jobs.status).not.toHaveBeenCalled();expect(jobs.chunk).not.toHaveBeenCalled();
  });
  it("rejects actor overrides, partial scope, invalid identities and unbounded pages",async()=>{
    expect((await post(root,{idempotencyKey:id,actor:"bob"})).status).toBe(400);
    expect((await post(root+"?warehouseId=1",{idempotencyKey:id})).status).toBe(400);
    for(const path of ["/wrong",`/${id}/chunks/-1`,`/${id}/chunks/2048`,`/${id}/chunks/00`]) expect((await fetch(root+path)).status).toBe(400);
    expect(jobs.enqueue).not.toHaveBeenCalled();expect(jobs.chunk).not.toHaveBeenCalled();
  });
  it("reports offline workers and redacts unexpected database failures",async()=>{
    jobs.enqueue.mockRejectedValueOnce(new InventoryCutoverOpeningError("CUTOVER_CAPTURE_WORKER_OFFLINE","Worker offline",503));
    expect(await (await post(root,{idempotencyKey:id})).json()).toEqual({error:{code:"CUTOVER_CAPTURE_WORKER_OFFLINE",message:"Worker offline"}});
    const log=vi.spyOn(console,"error").mockImplementation(()=>undefined);
    jobs.status.mockRejectedValueOnce(new Error("secret query"));
    const result=await fetch(`${root}/${id}`);expect(result.status).toBe(503);
    expect(JSON.stringify(await result.json())).not.toContain("secret");expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
});
