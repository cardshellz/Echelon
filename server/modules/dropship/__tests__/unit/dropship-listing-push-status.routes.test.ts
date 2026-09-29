import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipListingPushStatusService, DropshipVendorListingPushJob } from "../../application/dropship-listing-push-status-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipListingPushStatusRoutes, statusForListingPushStatusError } from "../../interfaces/http/dropship-listing-push-status.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const authCalls: string[] = [];
vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (req: Request, _res: Response, next: NextFunction) => {
    authCalls.push(req.path);
    req.session = { dropship: { memberId: "member-5" } } as unknown as Request["session"];
    next();
  },
  requireDropshipSensitiveActionProof: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const NOW = new Date("2026-09-28T17:55:00.000Z");

class FakeService {
  calls: Array<[string, number]> = [];
  fail: Error | null = null;

  async getForMember(memberId: string, jobId: number): Promise<DropshipVendorListingPushJob> {
    this.calls.push([memberId, jobId]);
    if (this.fail) throw this.fail;
    return {
      jobId, storeConnectionId: 5, platform: "ebay", environment: "production", status: "completed", finished: true,
      createdAt: NOW, updatedAt: NOW, completedAt: NOW,
      items: [{ itemId: 1, listingId: 100, productVariantId: 101, sku: "ARM-ENV-SGL-P50", productName: "Armalope Envelope Single Pocket",
        variantName: "Pack of 50", status: "completed", errorCode: null, errorMessage: null, retryable: null,
        externalListingId: "123456789012", published: true, listingUrl: "https://www.ebay.com/itm/123456789012" }],
    };
  }
}

describe("dropship vendor listing push status route", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeService;

  beforeEach(async () => {
    authCalls.length = 0;
    service = new FakeService();
    const app = express();
    registerDropshipListingPushStatusRoutes(app, service as unknown as DropshipListingPushStatusService);
    server = await startServer(app);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("serves the signed-in vendor's job, uncached", async () => {
    const response = await fetch(`${server.url}/api/dropship/listing-push-jobs/31`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(authCalls).toEqual(["/api/dropship/listing-push-jobs/31"]);
    expect(service.calls).toEqual([["member-5", 31]]);
    expect(await response.json()).toMatchObject({ job: { jobId: 31, finished: true, items: [{ listingUrl: "https://www.ebay.com/itm/123456789012" }] } });
  });

  it("passes a non-numeric id through as invalid", async () => {
    service.fail = new DropshipError("DROPSHIP_LISTING_PUSH_JOB_INVALID", "The listing push id is not valid.", { jobId: Number.NaN });
    const response = await fetch(`${server.url}/api/dropship/listing-push-jobs/abc`);
    expect(response.status).toBe(400);
    expect(service.calls).toEqual([["member-5", Number.NaN]]);
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_LISTING_PUSH_JOB_INVALID", message: "The listing push id is not valid." } });
  });

  it("maps not found, hides unexpected errors, and never sends error context", async () => {
    service.fail = new DropshipError("DROPSHIP_LISTING_PUSH_JOB_NOT_FOUND", "That listing push was not found.", { jobId: 31, secret: "x" });
    const notFound = await fetch(`${server.url}/api/dropship/listing-push-jobs/31`);
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: { code: "DROPSHIP_LISTING_PUSH_JOB_NOT_FOUND", message: "That listing push was not found." } });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    service.fail = new Error("boom");
    const failed = await fetch(`${server.url}/api/dropship/listing-push-jobs/31`);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: { code: "DROPSHIP_LISTING_PUSH_STATUS_INTERNAL_ERROR", message: "Listing push status request failed." } });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("knows the status of every error it can produce", () => {
    expect(statusForListingPushStatusError("DROPSHIP_AUTH_REQUIRED")).toBe(401);
    expect(statusForListingPushStatusError("DROPSHIP_LISTING_PUSH_JOB_INVALID")).toBe(400);
    expect(statusForListingPushStatusError("DROPSHIP_LISTING_PUSH_JOB_NOT_FOUND")).toBe(404);
    expect(statusForListingPushStatusError("DROPSHIP_LISTING_PUSH_STATUS_INVALID_ROW")).toBe(500);
  });
});

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
