import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEbayListingRecoveryRoutes } from "../../ebay-listing-recovery.routes";
import type { EbayListingRecoveryService } from "../../../../modules/channels/ebay-listing-recovery.service";
const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async (_user: string, _resource: string, _action: string) => true) }));
vi.mock("../../../../modules/identity", () => ({ hasPermission }));
const id = "655ca747-20b9-4940-9c61-019baf1c11c1";
describe("eBay operator recovery HTTP permission boundary", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let session: { user?: { id: string } };
  let url: string;
  let service: Pick<EbayListingRecoveryService, "inspect" | "preview" | "resume" | "inspectProduct" | "previewProduct" | "resumeProduct">;
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    vi.spyOn(console,"error").mockImplementation(() => undefined);
    session = { user: { id: "operator" } };
    service = { inspect: vi.fn(),preview: vi.fn(async () => ({ previewHash: "a".repeat(64),canResume: true,blockReason: null,attempts: [],jobId: id,productId: 20 })),resume: vi.fn(),
      inspectProduct: vi.fn(),previewProduct: vi.fn(async () => ({ previewHash: "a".repeat(64),canResume: true,blockReason: null,attempts: [],jobId: null,productId: 20 })),resumeProduct: vi.fn() };
    const app = express(); app.use(express.json());
    app.use((req,_res,next) => { (req as unknown as { session: typeof session }).session = session; next(); });
    registerEbayListingRecoveryRoutes(app,service,67);
    server = app.listen(0,"127.0.0.1");
    await new Promise<void>(resolve => server.once("listening",resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ebay/listings/sync-jobs/${id}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); vi.restoreAllMocks(); });
  it("shows permission limits in a read-only preview without authorizing recovery", async () => {
    hasPermission.mockImplementation(async (_user,resource) => resource !== "inventory_planning");
    const response = await fetch(url+"/recovery");
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ canResume: true,canRecover: false,requiredPermission: "inventory_planning:activate and channels:edit" });
    expect(service.resume).not.toHaveBeenCalled();
  });
  it.each(["channels","inventory_planning"])("requires %s capability before an operator resume", async resource => {
    hasPermission.mockImplementation(async (_user,current) => current !== resource);
    expect((await fetch(url+"/recovery",{ method: "POST",headers: { "Content-Type": "application/json" },body: "{}" })).status).toBe(403);
    expect(service.resume).not.toHaveBeenCalled();
  });
  it("requires authentication before any preview or permission check", async () => {
    session = {}; expect((await fetch(url+"/recovery")).status).toBe(401);
    expect(hasPermission).not.toHaveBeenCalled(); expect(service.preview).not.toHaveBeenCalled();
  });
  it("protects product recovery with the same inventory activation requirement", async () => {
    hasPermission.mockImplementation(async (_user,resource) => resource !== "inventory_planning");
    const productUrl = url.replace(`/sync-jobs/${id}`, "/products/20");
    expect((await fetch(productUrl+"/recovery")).status).toBe(200);
    expect((await fetch(productUrl+"/recovery",{ method: "POST",headers: { "Content-Type": "application/json" },body: "{}" })).status).toBe(403);
    expect(service.resumeProduct).not.toHaveBeenCalled();
  });
  it("takes the actor from the authenticated session, never a client override", async () => {
    const body = { previewHash: "a".repeat(64),idempotencyKey: id,acknowledgeUnknownOutcome: true };
    await fetch(url+"/recovery",{ method: "POST",headers: { "Content-Type": "application/json" },body: JSON.stringify(body) });
    expect(service.resume).toHaveBeenCalledExactlyOnceWith(id,67,"operator",body);
  });
  it("does not expose SQL or credentials in an unexpected failure", async () => {
    vi.mocked(service.preview).mockRejectedValueOnce(new Error("postgres://secret:password@database SQL SELECT"));
    const response = await fetch(url+"/recovery"); const body = await response.json();
    expect(response.status).toBe(500); expect(body.issue.nextStep).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/secret|password|SELECT/);
  });
});
