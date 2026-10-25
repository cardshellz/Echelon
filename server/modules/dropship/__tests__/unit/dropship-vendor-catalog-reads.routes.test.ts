import http from "http";
import type { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropshipSelectionAtpService } from "../../application/dropship-selection-atp-service";
import { DropshipError } from "../../domain/errors";
import { DROPSHIP_CATALOG_CODE_VERSION } from "../../domain/catalog-code-version";
import {
  CATALOG_CATEGORIES_RATE_LIMIT,
  CATALOG_IDS_RATE_LIMIT,
  registerDropshipVendorCatalogRoutes,
} from "../../interfaces/http/dropship-vendor-catalog.routes";
import { logger } from "../../../../platform/observability/logger";

/**
 * The catalog reads of step 1 plan S2-5 §4.8 and the retired-rules answer of
 * §4.9 item 2 at the HTTP boundary: the page version is read first, unknown
 * values are refused (never a fallback), each new answer is parsed with its
 * contract, budgets, and the status of every new code (§4.12).
 */
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository", () => ({
  createAuthorityAwareInventoryAtpService: () => ({}),
}));

class FakeCatalogReadService {
  previewInputs: unknown[] = [];
  idsInputs: unknown[] = [];
  summaryInputs: unknown[] = [];
  categoriesInputs: unknown[] = [];
  replaceError: unknown = null;

  async requireVendorForMember(memberId: string) {
    return { vendorId: 10, memberId, status: "active", entitlementStatus: "active" };
  }
  async previewCatalog(input: unknown) {
    this.previewInputs.push(input);
    return { rows: [], total: 0, page: 1, limit: 50, facets: null, summary: { matching: 3, matchingSelected: 1 } };
  }
  async listCatalogIds(input: unknown) {
    this.idsInputs.push(input);
    return { selectedIds: [7], notSelectedIds: [8, 9], total: 3 };
  }
  async listCatalogCategories(input: unknown) {
    this.categoriesInputs.push(input);
    return { categories: [{ categoryId: 5, name: "Supplies", rowCount: 2, selectedCount: 1 }], uncategorizedCount: 0 };
  }
  async readSelectionSummary(input: unknown) {
    this.summaryInputs.push(input);
    return { selectionRevisionId: 41, selectedTotal: 3, cap: 10_000, overCap: false, store: { storeConnectionId: 22, live: 1, notLive: 2 } };
  }
  async replaceSelectionRules() {
    if (this.replaceError) throw this.replaceError;
    return { revisionId: 1, idempotentReplay: false, rules: [] };
  }
}

describe("dropship vendor catalog reads (S2-5 §4.8, §4.9 item 2)", () => {
  let server: { url: string; close: () => Promise<void> } | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
    vi.restoreAllMocks();
  });

  async function start(service: FakeCatalogReadService) {
    server = await startServer(buildApp(service as unknown as DropshipSelectionAtpService));
    return server.url;
  }

  it("reads the new filters and keeps the stage 1 alias", async () => {
    const service = new FakeCatalogReadService();
    const url = await start(service);

    const response = await get(`${url}/api/dropship/catalog?selection=not_selected&categoryId=5&includeFacets=false&selectedOnly=true&clientVersion=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.body).toMatchObject({ summary: { matching: 3, matchingSelected: 1 }, facets: null });
    expect(service.previewInputs[0]).toMatchObject({
      vendorId: 10, selection: "not_selected", categoryId: 5, includeFacets: false, selectedOnly: true, page: 1, limit: 50,
    });

    // A stage 1 page: no new values, and its lenient selectedOnly reading is unchanged.
    await get(`${url}/api/dropship/catalog?selectedOnly=yes&page=2`);
    expect(service.previewInputs[1]).toMatchObject({ selection: undefined, selectedOnly: false, includeFacets: true, page: 2 });
  });

  it(`answers a page newer than catalog code version ${DROPSHIP_CATALOG_CODE_VERSION} with 503 "try again" on every catalog read, before the vendor read (CHK7)`, async () => {
    const service = new FakeCatalogReadService();
    const vendorRead = vi.spyOn(service, "requireVendorForMember");
    const url = await start(service);
    const newer = DROPSHIP_CATALOG_CODE_VERSION + 1;

    for (const path of [
      `/api/dropship/catalog?clientVersion=${newer}`,
      `/api/dropship/catalog?idsOnly=true&purpose=add&clientVersion=${newer}`,
      `/api/dropship/catalog/categories?clientVersion=${newer}`,
      `/api/dropship/catalog/selection?storeConnectionId=22&clientVersion=${newer}`,
    ]) {
      const response = await get(url + path);
      expect(response.status, path).toBe(503);
      expect(response.headers.get("retry-after"), path).toBe("5");
      expect(response.body.error, path).toMatchObject({
        code: "DROPSHIP_SELECTION_WRITES_PAUSED",
        context: { reason: "page_newer_than_server", clientVersion: newer, serverVersion: DROPSHIP_CATALOG_CODE_VERSION, retryable: true },
      });
    }
    expect(vendorRead).not.toHaveBeenCalled();
    expect(service.previewInputs).toEqual([]);
  });

  it.each([
    ["an unknown selection", "/api/dropship/catalog?selection=everything", "selection"],
    ["an unknown purpose", "/api/dropship/catalog?idsOnly=true&purpose=toggle", "purpose"],
    ["an id list without a purpose", "/api/dropship/catalog?idsOnly=true", "purpose"],
    ["a purpose without idsOnly", "/api/dropship/catalog?purpose=add", "idsOnly"],
    ["a malformed idsOnly flag", "/api/dropship/catalog?idsOnly=yes&purpose=add", "idsOnly"],
    ["a malformed includeFacets flag", "/api/dropship/catalog?includeFacets=0", "includeFacets"],
    ["a malformed category id", "/api/dropship/catalog?categoryId=5x", "categoryId"],
    ["a malformed client version", "/api/dropship/catalog?clientVersion=two", "clientVersion"],
    ["a zero client version", "/api/dropship/catalog/categories?clientVersion=0", "clientVersion"],
    ["a malformed store", "/api/dropship/catalog/selection?storeConnectionId=-1", "storeConnectionId"],
  ])("refuses %s with 400, never a fallback", async (_label, path, parameter) => {
    const service = new FakeCatalogReadService();
    const url = await start(service);

    const response = await get(url + path);
    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: "DROPSHIP_CATALOG_QUERY_INVALID", context: { parameter } });
    expect([...service.previewInputs, ...service.idsInputs, ...service.categoriesInputs, ...service.summaryInputs]).toEqual([]);
  });

  it("answers an id list, the categories and the selection summary through their contracts", async () => {
    const service = new FakeCatalogReadService();
    const url = await start(service);

    const ids = await get(`${url}/api/dropship/catalog?idsOnly=true&purpose=remove&search=env&selection=selected`);
    expect(ids).toMatchObject({ status: 200, body: { selectedIds: [7], notSelectedIds: [8, 9], total: 3 } });
    expect(service.idsInputs[0]).toMatchObject({ vendorId: 10, purpose: "remove", search: "env", selection: "selected" });
    expect(service.previewInputs).toEqual([]);

    expect(await get(`${url}/api/dropship/catalog/categories`)).toMatchObject({
      status: 200, body: { categories: [{ categoryId: 5, name: "Supplies" }], uncategorizedCount: 0 },
    });
    expect(service.categoriesInputs).toEqual([{ vendorId: 10 }]);

    expect(await get(`${url}/api/dropship/catalog/selection?storeConnectionId=22`)).toMatchObject({
      status: 200, body: { selectionRevisionId: 41, selectedTotal: 3, store: { live: 1, notLive: 2 } },
    });
    await get(`${url}/api/dropship/catalog/selection`);
    expect(service.summaryInputs).toEqual([{ vendorId: 10, storeConnectionId: 22 }, { vendorId: 10, storeConnectionId: null }]);
  });

  it("answers 500 (never a guessed shape) when a new answer breaks its contract, and logs it at ERROR", async () => {
    const service = new FakeCatalogReadService();
    vi.spyOn(service, "readSelectionSummary").mockResolvedValue({
      selectionRevisionId: 41, selectedTotal: 3, cap: 10_000, overCap: true, store: { storeConnectionId: 22, live: 1, notLive: 2 },
    });
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const url = await start(service);

    // overCap does not match the counts: the server's own answer is wrong, so 500, logged, nothing malformed sent.
    const response = await get(`${url}/api/dropship/catalog/selection`);
    expect(response).toMatchObject({ status: 500, body: { error: { code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR" } } });
    expect(error).toHaveBeenCalledWith("dropship.vendor_catalog.request_failed", expect.objectContaining({
      error_message: expect.stringContaining("failed its contract"),
    }));

    vi.spyOn(service, "listCatalogCategories").mockRejectedValue(new Error("private SQL detail"));
    const failed = await get(`${url}/api/dropship/catalog/categories`);
    expect(failed).toMatchObject({ status: 500, body: { error: { code: "DROPSHIP_VENDOR_CATALOG_INTERNAL_ERROR" } } });
    expect(JSON.stringify(failed.body)).not.toContain("private SQL detail");
    expect(error).toHaveBeenCalledWith("dropship.vendor_catalog.request_failed", expect.objectContaining({
      error_class: "fatal", path: "/api/dropship/catalog/categories", actor_id: "member-1",
    }));
  });

  it.each([
    ["DROPSHIP_CATALOG_IDS_TOO_MANY", 422],
    ["DROPSHIP_STORE_CONNECTION_REQUIRED", 404],
    ["DROPSHIP_IDEMPOTENCY_KEY_RESERVED", 400],
  ])("answers %s with %i", async (code, status) => {
    const service = new FakeCatalogReadService();
    vi.spyOn(service, "listCatalogIds").mockRejectedValue(new DropshipError(code, "refused", { retryable: false }));
    const url = await start(service);

    const response = await get(`${url}/api/dropship/catalog?idsOnly=true&purpose=add`);
    expect(response).toMatchObject({ status, body: { error: { code } } });
  });

  it("answers the rules save that B's freeze refused with 410 and the reload words, logged at INFO (§4.9 item 2)", async () => {
    const service = new FakeCatalogReadService();
    service.replaceError = new DropshipError("DROPSHIP_SELECTION_RULES_RETIRED",
      "This page was updated, so your last changes weren't saved. Reload it and make them again.", { retryable: false });
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const url = await start(service);

    const response = await fetchJson(`${url}/api/dropship/catalog/selection-rules`, {
      method: "PUT", headers: { "Content-Type": "application/json", "Idempotency-Key": "save-after-freeze" },
      body: JSON.stringify({ rules: [] }),
    });
    expect(response.status).toBe(410);
    expect(response.body.error).toMatchObject({
      code: "DROPSHIP_SELECTION_RULES_RETIRED",
      message: "This page was updated, so your last changes weren't saved. Reload it and make them again.",
    });
    expect(info).toHaveBeenCalledWith("dropship.selection.rules_retired_refused", expect.objectContaining({
      outcome: "refused", status: 410, actor_id: "member-1",
    }));
  });

  it(`spends the id budget (${CATALOG_IDS_RATE_LIMIT}/min) only on id lists, and the categories budget (${CATALOG_CATEGORIES_RATE_LIMIT}/min) per member`, async () => {
    const service = new FakeCatalogReadService();
    const url = await start(service);

    for (let call = 0; call < CATALOG_IDS_RATE_LIMIT; call += 1) {
      expect((await get(`${url}/api/dropship/catalog?idsOnly=true&purpose=add`)).status).toBe(200);
    }
    const over = await get(`${url}/api/dropship/catalog?idsOnly=true&purpose=add`);
    expect(over).toMatchObject({ status: 429, body: { error: { code: "DROPSHIP_CATALOG_READ_RATE_LIMITED" } } });
    // A table page is not an id list: it reads as before.
    expect((await get(`${url}/api/dropship/catalog?page=1`)).status).toBe(200);

    for (let call = 0; call < CATALOG_CATEGORIES_RATE_LIMIT; call += 1) {
      expect((await get(`${url}/api/dropship/catalog/categories`)).status).toBe(200);
    }
    expect((await get(`${url}/api/dropship/catalog/categories`)).status).toBe(429);
  });

  it("refuses every new read without a vendor session before any budget or service call", async () => {
    const service = new FakeCatalogReadService();
    server = await startServer(buildApp(service as unknown as DropshipSelectionAtpService, false));

    for (const path of ["/api/dropship/catalog?idsOnly=true&purpose=add", "/api/dropship/catalog/categories", "/api/dropship/catalog/selection"]) {
      expect((await get(server.url + path)).status, path).toBe(401);
    }
    expect([...service.idsInputs, ...service.categoriesInputs, ...service.summaryInputs]).toEqual([]);
  });
});

function buildApp(service: DropshipSelectionAtpService, authenticated = true): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { session: Record<string, unknown> }).session = authenticated
      ? { dropship: { authIdentityId: 1, memberId: "member-1", authMethod: "password", entitlementStatus: "active" } }
      : {};
    next();
  });
  registerDropshipVendorCatalogRoutes(app, service);
  return app;
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => { server.close((error) => (error ? reject(error) : resolve())); }),
  };
}

async function get(url: string) {
  return fetchJson(url, {});
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; headers: Headers; body: any }> {
  const response = await fetch(url, init);
  return { status: response.status, headers: response.headers, body: await response.json() };
}
