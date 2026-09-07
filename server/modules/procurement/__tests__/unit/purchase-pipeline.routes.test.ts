import { describe, expect, it, vi } from "vitest";
import type { Express } from "express";
import { registerPurchasePipelineRoutes } from "../../purchase-pipeline.routes";
import { createSupplierProgressService } from "../../supplier-progress.service";
import type { PipelineDatabase } from "../../purchase-pipeline.repository";

vi.mock("../../../../db", () => ({db:{}}));
vi.mock("../../../../routes/middleware", () => ({requirePermission:vi.fn((resource:string,action:string) => ({resource,action}))}));

function routes() {
  const definitions = new Map<string,unknown[]>();
  const app = {get:(path:string,...handlers:unknown[]) => definitions.set(`GET ${path}`,handlers),put:(path:string,...handlers:unknown[]) => definitions.set(`PUT ${path}`,handlers)};
  const database = {transaction:vi.fn()} as unknown as PipelineDatabase;
  registerPurchasePipelineRoutes(app as unknown as Express,database as never,() => new Date("2026-09-07T12:00:00Z"));
  const response = {status:vi.fn(),json:vi.fn()}; response.status.mockReturnValue(response);
  return {definitions,database,response};
}
describe("purchase pipeline HTTP boundary", () => {
  it("keeps read and progress write capabilities separate without running a query during registration", () => {
    const {definitions,database}=routes();
    expect(definitions.get("GET /api/purchasing/pipeline")?.[0]).toEqual({resource:"purchasing",action:"view"});
    expect(definitions.get("GET /api/purchasing/pipeline/lines/:id/progress")?.[0]).toEqual({resource:"purchasing",action:"view"});
    expect(definitions.get("PUT /api/purchasing/pipeline/lines/:id/progress")?.[0]).toEqual({resource:"purchasing",action:"edit"});
    expect(database.transaction).not.toHaveBeenCalled();
  });
  it.each(["7", "0", "90days", ["30","90"]])("rejects unsupported or repeated arrival horizon %j before database access", async(horizonDays) => {
    const {definitions,database,response}=routes();
    const handler=definitions.get("GET /api/purchasing/pipeline")!.at(-1) as Function;
    await handler({query:{horizonDays}},response);
    expect(response.status).toHaveBeenCalledWith(400); expect(database.transaction).not.toHaveBeenCalled();
  });
  it.each(["-1","1x","0","2147483648"])("rejects invalid line identity %s before owner dispatch", async(id) => {
    const {definitions,database,response}=routes();
    const handler=definitions.get("PUT /api/purchasing/pipeline/lines/:id/progress")!.at(-1) as Function;
    await handler({params:{id}},response);
    expect(response.status).toHaveBeenCalledWith(400); expect(database.transaction).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated or invalid supplier progress before starting a transaction", async() => {
    const {database}=routes(); const service=createSupplierProgressService(database,() => new Date());
    const command={expectedRevision:0,idempotencyKey:"10000000-0000-4000-8000-000000000001",report:{startedPieces:1,completedPieces:0,asOf:"2026-09-07T00:00:00Z",reference:"test",notes:""}};
    await expect(service.update(11,command,null)).rejects.toMatchObject({code:"SUPPLIER_PROGRESS_ACTOR_REQUIRED"});
    await expect(service.update(11,{...command,unsafe:true},"test")).rejects.toMatchObject({code:"SUPPLIER_PROGRESS_INVALID"});
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
