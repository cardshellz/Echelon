import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EbayListingMappingReview, EbayListingMappingResult } from "@shared/types/ebay-listing-mapping";
import type { EbayListingMappingService } from "../../../../modules/channels/ebay-listing-mapping.service";
import { EbayListingSyncError } from "../../../../modules/channels/ebay-listing-sync.domain";
import { registerEbayListingMappingRoutes } from "../../ebay-listing-mapping.routes";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn(async (_user: string, _resource: string, _action: string) => true) }));
vi.mock("../../../../modules/identity", () => ({ hasPermission }));
const commandKey = "655ca747-20b9-4940-9c61-019baf1c11c1";
const now = "2026-10-10T12:00:00.000Z";
const command = { reviewHash: "a".repeat(64), commandKey };
const review: EbayListingMappingReview = {
  productId: 20, reviewHash: command.reviewHash, observedAt: now,
  diagnosticCode: null, membership: null,
  title: "Saved offer needs updating", explanation: "eBay now publishes this SKU under offer 2.",
  rows: [{ variantId: 201, catalogSku: "PACK", savedSku: "PACK", savedOfferId: "1", savedListingId: "10",
    observedOffers: [{ sku: "PACK", offerId: "2", status: "PUBLISHED", listingId: "10", listingStatus: "ACTIVE" }],
    problem: "offer_changed", recommendation: "Use the verified offer 2." }],
  effects: ["Correct the saved offer and queue this product's sync."], canApply: true,
  allowedToApply: false, requiredPermission: "channels:edit",
  action: { kind: "apply_fix", label: "Apply fix and resume sync" }, manualSteps: [],
};
const result: EbayListingMappingResult = {
  repairStatus: "queued", replayed: false, receipt: { commandKey, productId: 20, reviewHash: command.reviewHash, appliedAt: now },
  job: { id: commandKey, productId: 20, kind: "sync", state: "queued", code: null, message: null, nextAttemptAt: now, updatedAt: now },
};

describe("eBay mapping review and repair HTTP boundary", () => {
  let server: ReturnType<ReturnType<typeof express>["listen"]>;
  let session: { user?: { id: string } };
  let url: string;
  let service: Pick<EbayListingMappingService, "diagnose" | "apply" | "getReceipt">;
  beforeEach(async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    session = { user: { id: "operator" } };
    service = { diagnose: vi.fn(async () => structuredClone(review)), apply: vi.fn(async () => structuredClone(result)), getReceipt: vi.fn(async () => null) };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { session: typeof session }).session = session; next(); });
    registerEbayListingMappingRoutes(app, service, 67);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ebay/listings/products/20`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
  });
  const post = (url: string, body: unknown) => fetch(`${url}/mapping-review`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  it("reads a fresh review without applying or resuming any update", async () => {
    const response = await fetch(`${url}/mapping-review`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ rows: review.rows, allowedToApply: true, canApply: true, requiredPermission: null });
    expect(service.diagnose).toHaveBeenCalledExactlyOnceWith(20, 67);
    expect(service.apply).not.toHaveBeenCalled();
  });
  it("shows the comparison but disables repair without edit permission", async () => {
    hasPermission.mockImplementation(async (_user, _resource, action) => action !== "edit");
    expect(await (await fetch(`${url}/mapping-review`)).json()).toMatchObject({ rows: review.rows, allowedToApply: false, canApply: false, requiredPermission: "channels:edit" });
    expect((await post(url, command)).status).toBe(403);
    expect(service.apply).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated access before reading provider or saved data", async () => {
    session = {};
    expect((await fetch(`${url}/mapping-review`)).status).toBe(401);
    expect((await fetch(`${url}/mapping-repairs/${commandKey}`)).status).toBe(401);
    expect(service.diagnose).not.toHaveBeenCalled();
    expect(service.getReceipt).not.toHaveBeenCalled();
  });
  it("validates exact command scope and takes the actor only from the session", async () => {
    expect((await post(url, { ...command, actor: "someone else" })).status).toBe(400);
    expect((await post(url, { ...command, offerId: "injected" })).status).toBe(400);
    expect(service.apply).not.toHaveBeenCalled();
    const response = await post(url, command);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(result);
    expect(service.apply).toHaveBeenCalledExactlyOnceWith(20, 67, "operator", command);
  });
  it("returns a specific stale-review action without accepting an old fix", async () => {
    vi.mocked(service.apply).mockRejectedValueOnce(new EbayListingSyncError("EBAY_MAPPING_REVIEW_STALE", "The listing changed during review."));
    const response = await post(url, command);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "EBAY_MAPPING_REVIEW_STALE", issue: { action: { kind: "review_mapping" } } });
  });
  it("looks up the exact receipt instead of borrowing another product's recent sync", async () => {
    expect((await fetch(`${url}/mapping-repairs/${commandKey}`)).status).toBe(404);
    expect(service.getReceipt).toHaveBeenCalledExactlyOnceWith(20, 67, commandKey);
    vi.mocked(service.getReceipt).mockResolvedValueOnce({ ...result, replayed: true });
    const response = await fetch(`${url}/mapping-repairs/${commandKey}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ receipt: result.receipt, replayed: true });
  });
  it("does not expose storage details from an unexpected error", async () => {
    vi.mocked(service.diagnose).mockRejectedValueOnce(new Error("postgres://secret:password@database SELECT"));
    const response = await fetch(`${url}/mapping-review`);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toMatch(/secret|password|SELECT/);
  });
  it("rejects invalid resource identifiers before accessing the service", async () => {
    expect((await fetch(`${url.replace("/20", "/-1")}/mapping-review`)).status).toBe(400);
    expect((await fetch(`${url}/mapping-repairs/not-a-uuid`)).status).toBe(400);
    expect(service.diagnose).not.toHaveBeenCalled();
    expect(service.getReceipt).not.toHaveBeenCalled();
  });
});
