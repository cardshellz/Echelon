import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayPublicationStockReview, EbayPublicationStockResult } from "@shared/types/ebay-publication-stock";
import type { EbayPublicationStockService } from "../../../../modules/channels/ebay-publication-stock.service";
import { EbayListingSyncError } from "../../../../modules/channels/ebay-listing-sync.domain";
import { registerEbayPublicationStockRoutes } from "../../ebay-publication-stock.routes";
const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async (_user: string, _resource: string, _action: string) => true) }));
vi.mock("../../../../modules/identity", () => ({ hasPermission }));
const commandKey = "655ca747-20b9-4940-9c61-019baf1c11c1";
const observedAt = "2026-10-12T15:00:00.000Z";
const command = { commandKey, expectedReviewHash: "a".repeat(64) };
const review: EbayPublicationStockReview = {
  productId: 232, productName: "Blue Toploader", observedAt, reviewHash: command.expectedReviewHash,
  inventory: { channelId: 67, connectionId: 34, productId: 232, publicationTargetId: 3, targetRevision: "2", reviewHash: "b".repeat(64),
    ready: true, currentlyReady: false, variants: [{ productVariantId: 463, sku: "BLUE-P10", mappingAction: "promote_draft", membershipAction: "include", desiredQuantity: "12" }], blockers: [], effects: ["Seal the reviewed exact SKU mapping."] },
  canApply: true, allowedToApply: true, requiredPermission: null, effects: ["Save publication in the same transaction."],
};
const result: EbayPublicationStockResult = { replayed: false,
  receipt: { commandKey, productId: 232, reviewHash: command.expectedReviewHash, appliedAt: observedAt },
  job: { id: commandKey, productId: 232, kind: "sync", operation: "publish", state: "queued", code: null, message: null, nextAttemptAt: observedAt, updatedAt: observedAt },
};

describe("eBay reviewed stock enrollment HTTP boundary", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let session: { user?: { id: string } };
  let url: string;
  let service: Pick<EbayPublicationStockService, "review" | "apply" | "getReceipt">;
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    session = { user: { id: "operator" } };
    service = { review: vi.fn(async () => structuredClone(review)), apply: vi.fn(async () => structuredClone(result)), getReceipt: vi.fn(async () => null) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { session: typeof session }).session = session; next(); });
    registerEbayPublicationStockRoutes(app, service);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ebay/listings/products/232/publication-readiness`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
  });
  const post = (url: string, body: unknown) => fetch(`${url}/apply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  it("reads the exact stock proposal without applying it or publishing", async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(review); expect(service.review).toHaveBeenCalledExactlyOnceWith(232); expect(service.apply).not.toHaveBeenCalled();
  });
  it.each(["channels", "inventory_planning"])("requires %s permission for Apply and accurately explains missing permission", async resource => {
    hasPermission.mockImplementation(async (_user, current, action) => !(current === resource && action === (resource === "channels" ? "edit" : "activate")));
    const response = await fetch(url);
    expect(await response.json()).toMatchObject({ canApply: false, allowedToApply: false, requiredPermission: resource === "channels" ? "channels:edit" : "inventory_planning:activate" });
    expect((await post(url, command)).status).toBe(403); expect(service.apply).not.toHaveBeenCalled();
  });
  it("rejects missing authentication and channels read permission before any owner calls", async () => {
    session = {};
    expect((await fetch(url)).status).toBe(401); expect((await post(url, command)).status).toBe(401); expect((await fetch(`${url}/commands/${commandKey}`)).status).toBe(401);
    session = { user: { id: "operator" } }; hasPermission.mockResolvedValue(false);
    expect((await fetch(url)).status).toBe(403); expect((await fetch(`${url}/commands/${commandKey}`)).status).toBe(403);
    expect(service.review).not.toHaveBeenCalled(); expect(service.apply).not.toHaveBeenCalled(); expect(service.getReceipt).not.toHaveBeenCalled();
  });
  it("keeps a blocked review blocked even for fully authorized operators", async () => {
    vi.mocked(service.review).mockResolvedValue({ ...review, canApply: false });
    expect(await (await fetch(url)).json()).toMatchObject({ canApply: false, allowedToApply: true, requiredPermission: null });
  });
  it("links a prior publication refusal to its exact saved status", async () => {
    const failure = Object.assign(new EbayListingSyncError("EBAY_PUBLICATION_PRIOR_WORK_REQUIRED", "An earlier publication must finish first."), { jobId: commandKey });
    vi.mocked(service.review).mockRejectedValue(failure);
    vi.mocked(service.apply).mockRejectedValue(failure);
    for (const response of [await fetch(url), await post(url, command)]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: failure.code, issue: { reference: commandKey, action: { kind: "check_status" }, details: [{ label: "Product ID", value: "232" }] } });
    }
  });
  it.each([{ ...command, actor: "foreign" }, { ...command, desiredQuantity: 100000 }, { ...command, expectedReviewHash: "old" }, { expectedReviewHash: command.expectedReviewHash }])("rejects untrusted command fields %j", async body => {
    expect((await post(url, body)).status).toBe(400); expect(service.apply).not.toHaveBeenCalled();
  });
  it("uses the session actor and returns one queued publication receipt", async () => {
    const response = await post(url, command); expect(response.status).toBe(202); expect(await response.json()).toEqual(result);
    expect(service.apply).toHaveBeenCalledExactlyOnceWith(232, "operator", command);
  });
  it("recovers exact product and command receipts, returning404 for no known outcome", async () => {
    const missing = await fetch(`${url}/commands/${commandKey}`); expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "EBAY_PUBLICATION_STOCK_COMMAND_NOT_FOUND" });
    expect(service.getReceipt).toHaveBeenCalledExactlyOnceWith(232, commandKey);
    vi.mocked(service.getReceipt).mockResolvedValue({ ...result, replayed: true });
    const replay = await fetch(`${url}/commands/${commandKey}`); expect(replay.headers.get("cache-control")).toBe("no-store"); expect(await replay.json()).toMatchObject({ receipt: result.receipt, replayed: true });
  });
  it("distinguishes a durable refusal from the same code before a rejection was committed", async () => {
    const failure = new EbayListingSyncError("EBAY_PUBLICATION_STOCK_REVIEW_STALE", "Stock changed; review again.");
    vi.mocked(service.apply).mockRejectedValueOnce(failure);
    expect(await (await post(url, command)).json()).toMatchObject({ definitiveRejected: false });
    vi.mocked(service.apply).mockRejectedValueOnce(Object.assign(failure, { definitiveRejected: true }));
    const response = await post(url, command); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: failure.code, definitiveRejected: true });
  });
  it("validates product and command paths before reading or applying", async () => {
    expect((await fetch(url.replace("/232/", "/not-an-id/"))).status).toBe(400);
    expect((await fetch(`${url}/commands/not-a-uuid`)).status).toBe(400); expect(service.review).not.toHaveBeenCalled(); expect(service.getReceipt).not.toHaveBeenCalled();
  });
  it("keeps secrets out of errors after an unknown commit outcome", async () => {
    vi.mocked(service.apply).mockRejectedValue(new Error("postgres://private:secret internal SQL"));
    const response = await post(url, command); expect(response.status).toBe(500); const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("secret"); expect(body.definitiveRejected).toBe(false);
  });
});
