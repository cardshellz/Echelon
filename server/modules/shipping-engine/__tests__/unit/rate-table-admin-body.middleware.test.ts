import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import http from "http";
import { AddressInfo } from "net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GLOBAL_JSON_LIMIT_BYTES,
  RATE_TABLE_ADMIN_JSON_LIMIT_BYTES,
  installGlobalJsonBodyParser,
  isRateTableAdminBulkJsonRequest,
  parseRateTableAdminBulkJson,
} from "../../interfaces/http/rate-table-admin-body.middleware";

describe("rate-table admin JSON body parsing", () => {
  let server: { url: string; close: () => Promise<void> };

  beforeEach(async () => {
    server = await startServer(buildApp());
  });

  afterEach(async () => server.close());

  it.each([
    "/api/shipping/admin/rate-tables/drafts",
    "/api/shipping/admin/rate-tables/123",
  ])("accepts an authorized draft payload larger than the global limit at %s", async (path) => {
    const body = JSON.stringify({
      rows: [{ padding: "x".repeat(GLOBAL_JSON_LIMIT_BYTES + 8_000) }],
    });
    const response = await jsonRequest(
      `${server.url}${path}`,
      body,
      { "x-test-authorized": "true" },
    );

    expect(Buffer.byteLength(body)).toBeGreaterThan(GLOBAL_JSON_LIMIT_BYTES);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      parsed: true,
      rawBodyBytes: Buffer.byteLength(body),
    });
  });

  it("keeps the existing 100kb limit on unrelated JSON endpoints", async () => {
    const body = JSON.stringify({
      padding: "x".repeat(GLOBAL_JSON_LIMIT_BYTES + 8_000),
    });
    const response = await jsonRequest(`${server.url}/api/unrelated`, body);

    expect(response.status).toBe(413);
  });

  it("preserves raw-body capture on ordinary JSON endpoints", async () => {
    const body = JSON.stringify({ example: "signed webhook body" });
    const response = await jsonRequest(`${server.url}/api/unrelated`, body);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      parsed: true,
      rawBodyBytes: Buffer.byteLength(body),
    });
  });

  it("authorizes before parsing a bulk rate-table body", async () => {
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/rate-tables/drafts`,
      "{malformed",
    );

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthorized" });
  });

  it("returns a structured error when the bounded admin limit is exceeded", async () => {
    const body = JSON.stringify({
      padding: "x".repeat(RATE_TABLE_ADMIN_JSON_LIMIT_BYTES),
    });
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/rate-tables/drafts`,
      body,
      { "x-test-authorized": "true" },
    );

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: {
        code: "SHIPPING_ADMIN_REQUEST_TOO_LARGE",
        message:
          "The shipping rate draft is too large to save. Reduce the draft size or import it in smaller sections.",
        details: [],
      },
    });
  });

  it("returns a structured error for malformed authorized JSON", async () => {
    const response = await jsonRequest(
      `${server.url}/api/shipping/admin/rate-tables/drafts`,
      "{malformed",
      { "x-test-authorized": "true" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "SHIPPING_ADMIN_JSON_INVALID",
        message: "The shipping rate request body is not valid JSON.",
        details: [],
      },
    });
  });
});

describe("rate-table bulk request matching", () => {
  it.each([
    ["POST", "/api/shipping/admin/rate-tables/parse-csv"],
    ["POST", "/api/shipping/admin/rate-tables/drafts"],
    ["POST", "/api/shipping/admin/rate-tables/import/"],
    ["PUT", "/api/shipping/admin/rate-tables/123"],
  ])("matches %s %s", (method, path) => {
    expect(isRateTableAdminBulkJsonRequest(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/api/shipping/admin/rate-tables/123"],
    ["POST", "/api/shipping/admin/rate-tables/123/activate"],
    ["PUT", "/api/shipping/admin/rate-tables/123/rows/456"],
    ["POST", "/api/shipping/admin/rate-books"],
  ])("does not match %s %s", (method, path) => {
    expect(isRateTableAdminBulkJsonRequest(method, path)).toBe(false);
  });
});

function buildApp(): express.Express {
  const app = express();
  installGlobalJsonBodyParser(app);
  app.post("/api/unrelated", echoParsedBody);
  app.post(
    [
      "/api/shipping/admin/rate-tables/parse-csv",
      "/api/shipping/admin/rate-tables/drafts",
      "/api/shipping/admin/rate-tables/import",
    ],
    requireTestAuthorization,
    parseRateTableAdminBulkJson,
    echoParsedBody,
  );
  app.put(
    "/api/shipping/admin/rate-tables/:id",
    requireTestAuthorization,
    parseRateTableAdminBulkJson,
    echoParsedBody,
  );
  app.use((
    error: { status?: number },
    _req: Request,
    res: Response,
    _next: NextFunction,
  ) => {
    res.status(error.status ?? 500).json({ error: "Request failed" });
  });
  return app;
}

function requireTestAuthorization(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.get("x-test-authorized") !== "true") {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

function echoParsedBody(req: Request, res: Response): void {
  res.json({
    parsed: typeof req.body === "object",
    rawBodyBytes: Buffer.isBuffer(req.rawBody) ? req.rawBody.length : null,
  });
}

async function startServer(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function jsonRequest(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: target.pathname.includes("/rate-tables/123") ? "PUT" : "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(rawBody) as Record<string, unknown>,
        });
      });
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}
