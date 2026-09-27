import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerInventoryCutoverHistoryRoutes } from "../../interfaces/http/inventory-cutover-history.routes";
import { InventoryCutoverHistoryService } from "../../application/inventory-cutover-history.service";
import { CutoverHistoryError, reviewHistoricalWork } from "../../domain/inventory-cutover-history-retirement";
import { historyFixture } from "../fixtures/inventory-cutover-history.fixture";
import type { HistoryRetirementResult } from "@shared/types/inventory-cutover-history";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async () => true) }));
vi.mock("../../../identity", () => ({ hasPermission }));
vi.mock("../../../../db", () => ({ pool: {} }));
const ROOT = "/api/inventory-planning/admin/cutover-history";
describe("authenticated bulk history review and retirement", () => {
  let server: http.Server;
  let url: string;
  let actor: string | undefined;
  const { source,facts } = historyFixture();
  const review = reviewHistoricalWork(source,facts);
  const input = { expectedReviewHash: review.reviewHash,expectedAuthorityRevision: "1",expectedConfigurationRunId: null,
    acceptUnresolvedOrigin: false,reason: "Reviewed history only",idempotencyKey: "route-history" };
  const result: HistoryRetirementResult = { batchId: "1",reviewHash: review.reviewHash,retiredReceipts: 1,retiredShipments: 1,
    quarantinedReceipts: 0,actor: "operator",reason: input.reason,occurredAt: source.capturedAt,alreadyApplied: false,
    inventoryChanged: false,authorityChanged: false };
  const store = { review: vi.fn(async () => review), retire: vi.fn(async () => result) };
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true); actor="operator";
    store.review.mockReset().mockResolvedValue(review); store.retire.mockReset().mockResolvedValue(result);
    vi.spyOn(console,"error").mockImplementation(() => undefined);
    const app = express(); app.use(express.json());
    app.use((req,_res,next) => { Object.defineProperty(req,"session",{ value: { user: actor ? { id: actor } : undefined } }); next(); });
    registerInventoryCutoverHistoryRoutes(app,new InventoryCutoverHistoryService(store));
    server = http.createServer(app); await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
    url=`http://127.0.0.1:${(server.address() as AddressInfo).port}${ROOT}`;
  });
  afterEach(async () => { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); vi.restoreAllMocks(); });
  async function send(action: "review" | "retire", body: unknown = input, query="") {
    const response = await fetch(`${url}/${action}${query}`,{ method: action === "review" ? "GET" : "POST",
      headers: { "Content-Type":"application/json" }, ...(action === "retire" ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, cache: response.headers.get("cache-control"), body: await response.json() };
  }
  it("uses activate permission/session identity and returns a no-write review", async () => {
    expect(await send("review")).toMatchObject({ status: 200,cache: "no-store",body: { activatesInventory: false } });
    expect(hasPermission).toHaveBeenCalledWith("operator","inventory_planning","activate");
    expect(store.retire).not.toHaveBeenCalled();
  });
  it("reports fresh versus idempotent retirement without claiming inventory activation", async () => {
    expect(await send("retire")).toMatchObject({ status: 201,body: { inventoryChanged: false,authorityChanged: false } });
    expect(store.retire).toHaveBeenCalledWith(expect.objectContaining({ actor: "operator",expectedReviewHash: review.reviewHash }));
    store.retire.mockResolvedValueOnce({ ...result,alreadyApplied: true });
    expect(await send("retire")).toMatchObject({ status: 200,body: { alreadyApplied: true } });
  });
  it.each(["review","retire"] as const)("rejects missing/denied permissions for %s", async action => {
    actor=undefined; expect((await send(action)).status).toBe(401);
    actor="operator"; hasPermission.mockResolvedValue(false); expect((await send(action)).status).toBe(403);
    expect(store.review).not.toHaveBeenCalled(); expect(store.retire).not.toHaveBeenCalled();
  });
  it.each([{ actor:"spoof" },{ idempotencyKey:"" },{ expectedAuthorityRevision:"not-a-number" },{ acceptUnresolvedOrigin:"true" }])(
    "rejects invalid or widened commands %#", async change => {
      expect((await send("retire",{ ...input,...change })).status).toBe(400); expect(store.retire).not.toHaveBeenCalled();
    });
  it.each(["review","retire"] as const)("rejects partial query scope for %s", async action => {
    expect((await send(action,input,"?receiptId=20")).status).toBe(400);
    expect(store.review).not.toHaveBeenCalled(); expect(store.retire).not.toHaveBeenCalled();
  });
  it("reports typed conflicts and hides raw database errors; invalid owner output is not success", async () => {
    store.retire.mockRejectedValueOnce(new CutoverHistoryError("HISTORY_REVIEW_CHANGED","Refresh the complete review"));
    expect(await send("retire")).toMatchObject({ status: 409,body: { error: { code: "HISTORY_REVIEW_CHANGED" } } });
    store.retire.mockRejectedValueOnce(new Error("secret database payload"));
    const failed = await send("retire"); expect(failed.status).toBe(500); expect(JSON.stringify(failed)).not.toContain("secret");
    store.retire.mockResolvedValueOnce({ ...result,inventoryChanged: true } as unknown as HistoryRetirementResult);
    expect((await send("retire")).status).toBe(500);
  });
});
