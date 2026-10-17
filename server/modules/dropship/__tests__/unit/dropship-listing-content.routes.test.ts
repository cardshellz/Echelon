import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listingContentTargetSchema, previewListingContentInputSchema, saveListingContentInputSchema, saveContentProfileInputSchema } from "../../../../../shared/dropship/listing-content";
import { contentCandidate, noContentProfile } from "../fixtures/listing-content.fixture";
import { resolveListingContent } from "../../application/dropship-listing-content-resolver";
import { DropshipError } from "../../domain/errors";
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
import { registerDropshipListingContentRoutes } from "../../interfaces/http/dropship-listing-content.routes";
import { CONTENT_PROFILE_TOO_LARGE_MESSAGE, DROPSHIP_BULK_JSON_LIMIT_BYTES } from "../../interfaces/http/dropship-bulk-json.middleware";
import { installGlobalJsonBodyParser } from "../../../shipping-engine/interfaces/http/rate-table-admin-body.middleware";
const content = { storeConnectionId: 22, productVariantId: 101, customText: null, revisionId: null, updatedAt: null,
  resolved: resolveListingContent({ candidate: contentCandidate(), profile: noContentProfile, saved: null }) };
const input = { customText: "My copy", expectedRevisionId: null, expectedProfileRevisionId: null,
  expectedCatalogHash: content.resolved.catalogHash, idempotencyKey: "content-save" };
describe("content HTTP boundary", () => {
  let server: http.Server; let url: string;
  const service = {
    getProfile: vi.fn(async () => noContentProfile),
    saveProfile: vi.fn(async (_member: string, _store: unknown, body: unknown) => { saveContentProfileInputSchema.parse(body); return { state: noContentProfile, idempotentReplay: false }; }),
    targetsForMember: vi.fn(async () => ({ total: 0, rows: [] })),
    getForMember: vi.fn(async (_member: string, target: unknown) => { listingContentTargetSchema.parse(target); return content; }),
    saveForMember: vi.fn(async (_member: string, target: unknown, body: unknown) => {
      listingContentTargetSchema.parse(target); saveListingContentInputSchema.parse(body); return { content, idempotentReplay: false };
    }),
    previewForMember: vi.fn(async (_member: string, target: unknown, body: unknown) => {
      listingContentTargetSchema.parse(target); previewListingContentInputSchema.parse(body); return content;
    }),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { const memberId = req.header("X-Test-Member");
      req.session = { ...(memberId ? { dropship: { memberId } } : {}) } as Request["session"]; next(); });
    registerDropshipListingContentRoutes(app, service);
    server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores/22`;
  });
  afterEach(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const path = "/variants/101/content";
  function request(method: string, suffix = path, body: unknown = input, member = "member-1") {
    return fetch(url + suffix, { method, headers: { "Content-Type": "application/json", ...(member ? { "X-Test-Member": member } : {}) },
      ...(method !== "GET" ? { body: JSON.stringify(body) } : {}) });
  }
  it.each([["GET", path], ["PUT", path], ["POST", path + "/preview"], ["GET", "/content-profile"], ["PUT", "/content-profile"], ["GET", "/content-profile/targets"]])("requires member auth for %s %s", async (method, suffix) => {
    expect((await request(method, suffix, input, "")).status).toBe(401);
    expect(service.getForMember).not.toHaveBeenCalled(); expect(service.saveForMember).not.toHaveBeenCalled();
  });
  it("returns no-store content and uses the authenticated member for writes", async () => {
    const loaded = await request("GET"); expect(loaded.status).toBe(200); expect(loaded.headers.get("Cache-Control")).toBe("no-store");
    expect((await request("PUT")).status).toBe(200);
    expect(service.saveForMember).toHaveBeenCalledWith("member-1", { storeConnectionId: 22, productVariantId: 101 }, input);
  });
  it.each([{ ...input, sku: "forged" }, { ...input, customText: "" }, { ...input, vendorId: 999 }, { ...input, expectedCatalogHash: "bad" }])("rejects invalid or extra authority fields", async (body) => {
    expect((await request("PUT", path, body)).status).toBe(400);
  });
  // A rules conversion writes the store's templates under `lc:<hash>:content_profile:<store>` (plan D12): no vendor save may take it.
  const RESERVED_KEY = `lc:${"a".repeat(64)}:content_profile:22`;
  const profileInput = { expectedRevisionId: null, profile: { defaultTemplate: { introduction: "", footer: "" }, groups: [] }, idempotencyKey: "content-profile-save" };
  it.each([["PUT", "/content-profile", profileInput], ["PUT", path, input]])("refuses a conversion's reserved key on %s %s with 400", async (method, suffix, body) => {
    const refused = await request(method, suffix, { ...body, idempotencyKey: RESERVED_KEY });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: { code: "DROPSHIP_CONTENT_INVALID_INPUT",
      message: "Check the description fields and reload if the draft is out of date." } });
    expect((await request(method, suffix, { ...body, idempotencyKey: "rules-conversion:22" })).status).toBe(400);
    expect((await request(method, suffix, body)).status).toBe(200);
  });
  it.each([["DROPSHIP_CONTENT_VERSION_CONFLICT", 409], ["DROPSHIP_IDEMPOTENCY_CONFLICT", 409],
    ["DROPSHIP_CONTENT_NOT_ALLOWED", 403], ["DROPSHIP_CONTENT_NOT_AVAILABLE", 404], ["DROPSHIP_STORE_CONNECTION_REQUIRED", 404]])("maps %s to %s", async (code, status) => {
    service.saveForMember.mockRejectedValueOnce(new DropshipError(String(code), "Controlled error."));
    expect((await request("PUT")).status).toBe(status);
  });
  it("treats broken output as server failure, not bad user input", async () => {
    service.getForMember.mockResolvedValueOnce({ ...content, revisionId: -1 });
    expect((await request("GET")).status).toBe(500);
  });
});

describe("content profile body behind the 1 MiB parser (plan PR 9, P8)", () => {
  let server: http.Server; let url: string;
  const service = {
    getProfile: vi.fn(), targetsForMember: vi.fn(), getForMember: vi.fn(), saveForMember: vi.fn(), previewForMember: vi.fn(),
    saveProfile: vi.fn(async (_member: string, _store: unknown, body: unknown) => {
      saveContentProfileInputSchema.parse(body); return { state: noContentProfile, idempotentReplay: false };
    }),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.use((req, _res, next) => { const memberId = req.header("X-Test-Member");
      req.session = { ...(memberId ? { dropship: { memberId } } : {}) } as Request["session"]; next(); });
    // The production order: the global 100 KB parser skips the profile PUT, which parses its own body after sign-in.
    installGlobalJsonBodyParser(app);
    registerDropshipListingContentRoutes(app, service);
    server = http.createServer(app); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dropship/listings/stores/22/content-profile`;
  });
  afterEach(async () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const put = (text: string, member: string | null = "member-1") => fetch(url, { method: "PUT",
    headers: { "Content-Type": "application/json", ...(member ? { "X-Test-Member": member } : {}) }, body: text });
  const part = (letter: string) => letter.repeat(4_000);

  it("parses descriptions past the 100 KB global limit (30 groups of two 4,000-character parts) and hands them over unchanged", async () => {
    const large = { expectedRevisionId: null, idempotencyKey: "content-profile-save", profile: {
      defaultTemplate: { introduction: part("a"), footer: part("b") },
      groups: Array.from({ length: 30 }, (_, index) => ({ id: `group-${index}`, name: `Group ${index}`, priority: index + 1,
        scope: { type: "category", category: `Category ${index}` }, template: { introduction: part("c"), footer: part("d") } })) } };
    const text = JSON.stringify(large);
    expect(text.length).toBeGreaterThan(100 * 1024);
    const response = await put(text);
    expect(response.status).toBe(200);
    expect(service.saveProfile).toHaveBeenCalledWith("member-1", 22, large);
  });

  it("refuses a body over 1 MiB with 413 in the descriptions' own words, never calling the service", async () => {
    const response = await put(JSON.stringify({ padding: "x".repeat(DROPSHIP_BULK_JSON_LIMIT_BYTES + 1) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "DROPSHIP_REQUEST_TOO_LARGE", message: CONTENT_PROFILE_TOO_LARGE_MESSAGE } });
    expect(service.saveProfile).not.toHaveBeenCalled();
  });

  it("still refuses an anonymous save before parsing it", async () => {
    expect((await put("{}", null)).status).toBe(401);
    expect(service.saveProfile).not.toHaveBeenCalled();
  });
});
