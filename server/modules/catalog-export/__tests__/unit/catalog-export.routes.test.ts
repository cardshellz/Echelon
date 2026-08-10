import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerCatalogExportRoutes,
  type CatalogExportRouteDependencies,
} from "../../interfaces/http/catalog-export.routes";
import { InvalidCatalogExportCursorError } from "../../domain/catalog-export";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const listPage = vi.fn<CatalogExportRouteDependencies["listPage"]>();
let configuredKey: string | undefined = "catalog-export-test-key-1234567890";
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  registerCatalogExportRoutes(app, {
    readApiKey: () => configuredKey,
    listPage,
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  configuredKey = "catalog-export-test-key-1234567890";
  listPage.mockReset();
  listPage.mockResolvedValue({
    externalSourceId: "tenant-1",
    items: [],
    nextCursor: null,
  });
});

describe("catalog export routes", () => {
  it("fails closed when the dedicated integration key is not configured", async () => {
    configuredKey = undefined;
    const response = await getCatalog();

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: {
        code: "CATALOG_EXPORT_NOT_CONFIGURED",
        message: "Catalog export is not configured.",
      },
    });
    expect(listPage).not.toHaveBeenCalled();
  });

  it("fails closed when the configured integration key is too weak", async () => {
    configuredKey = "short-key";
    const response = await getCatalog("short-key");

    expect(response.status).toBe(503);
    expect(listPage).not.toHaveBeenCalled();
  });

  it("rejects missing or incorrect credentials without exposing configuration", async () => {
    expect((await getCatalog(null)).status).toBe(401);
    expect((await getCatalog("wrong-key")).status).toBe(401);
    expect(listPage).not.toHaveBeenCalled();
  });

  it("returns the versioned normalized page contract", async () => {
    const response = await getCatalog("catalog-export-test-key-1234567890", "?limit=25");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ externalSourceId: "tenant-1", items: [], nextCursor: null });
    expect(listPage).toHaveBeenCalledWith({ cursor: null, limit: 25 });
  });

  it("rejects unknown query parameters and invalid limits", async () => {
    expect((await getCatalog("catalog-export-test-key-1234567890", "?unexpected=true")).status).toBe(400);
    expect((await getCatalog("catalog-export-test-key-1234567890", "?limit=1001")).status).toBe(400);
    expect(listPage).not.toHaveBeenCalled();
  });

  it("classifies an invalid cursor without logging it as an internal failure", async () => {
    listPage.mockRejectedValueOnce(new InvalidCatalogExportCursorError());
    const response = await getCatalog("catalog-export-test-key-1234567890", "?cursor=invalid");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "CATALOG_EXPORT_CURSOR_INVALID",
        message: "Catalog export cursor is invalid.",
      },
    });
  });
});

async function getCatalog(
  apiKey: string | null = "catalog-export-test-key-1234567890",
  query = "",
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/api/integrations/catalog/v1/items${query}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
  return { status: response.status, body: await response.json() };
}
