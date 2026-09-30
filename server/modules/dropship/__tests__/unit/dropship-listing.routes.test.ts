import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createListingPushJobForMemberInputSchema } from "../../application/dropship-listing-dtos";
import type { DropshipListingPreviewService } from "../../application/dropship-listing-preview-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipListingRoutes } from "../../interfaces/http/dropship-listing.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.session = { dropship: { memberId: "member-5" } } as unknown as Request["session"];
    next();
  },
  requireDropshipSensitiveActionProof: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const HASH = "a".repeat(64);
const GENERATED_AT = new Date("2026-09-30T12:00:00.000Z");

/** One valid value per field of the member push contract. */
const FULL_PUSH_BODY: Record<string, unknown> = {
  storeConnectionId: 5,
  productVariantIds: [101],
  reviewMode: "reviewed_preview",
  requestedRetailPriceCents: 1299,
  requestedRetailPricesByVariantId: { "101": 1299 },
  expectedPriceRevisionIdsByVariantId: { "101": 3 },
  expectedPriceCentsByVariantId: { "101": 1299 },
  expectedRuleEvidenceHashesByVariantId: { "101": HASH },
  expectedContentEvidenceHashesByVariantId: { "101": HASH },
  expectedMarketplaceCategoryEvidenceHashesByVariantId: { "101": HASH },
  idempotencyKey: "push-key-0001",
};

class FakeService {
  calls: Array<{ memberId: string; input: Record<string, unknown> }> = [];
  fail: Error | null = null;

  async createListingPushJobForMember(memberId: string, input: Record<string, unknown>) {
    this.calls.push({ memberId, input });
    if (this.fail) throw this.fail;
    return {
      job: { jobId: 31, status: "queued" },
      items: [],
      preview: {
        vendorId: 10, storeConnectionId: 5, platform: "ebay", generatedAt: GENERATED_AT,
        summary: { total: 0, ready: 0, warning: 0, blocked: 0 }, rows: [],
      },
      idempotentReplay: false,
    };
  }
}

describe("dropship vendor listing push route", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeService;

  beforeEach(async () => {
    service = new FakeService();
    const app = express();
    app.use(express.json());
    registerDropshipListingRoutes(app, service as unknown as DropshipListingPreviewService);
    server = await startServer(app);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("covers every field of the member push contract", () => {
    // Guards the fixture: a field added to the contract must be added here, which
    // makes the forwarding test below fail until the route passes it through.
    expect(Object.keys(FULL_PUSH_BODY).sort()).toEqual(Object.keys(createListingPushJobForMemberInputSchema.shape).sort());
    expect(createListingPushJobForMemberInputSchema.safeParse(FULL_PUSH_BODY).success).toBe(true);
  });

  it("forwards every field of the push contract to the service unchanged", async () => {
    const response = await post(FULL_PUSH_BODY);
    expect(response.status).toBe(201);
    expect(service.calls).toEqual([{ memberId: "member-5", input: FULL_PUSH_BODY }]);
  });

  it("answers a changed eBay category with 409 so the vendor reviews a new preview", async () => {
    service.fail = new DropshipError("DROPSHIP_LISTING_CATEGORY_VERSION_CONFLICT",
      "eBay categories changed since your preview. Generate and review a new preview before queueing.");
    const response = await post(FULL_PUSH_BODY);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("DROPSHIP_LISTING_CATEGORY_VERSION_CONFLICT");
  });

  function post(body: Record<string, unknown>) {
    return fetch(`${server.url}/api/dropship/listing-push-jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
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
