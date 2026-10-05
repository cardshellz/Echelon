import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { financeErrorEnvelopeSchema, type FinanceSummary } from "../../../../../shared/dropship/program-finance";
import {
  DropshipFinanceService,
  type DropshipFinanceRepository,
  type FinanceSummaryRead,
} from "../../application/dropship-finance-service";
import { DropshipError } from "../../domain/errors";
import { FINANCE_FIXTURE_NOW, fixtureRaw } from "../fixtures/program-finance-raw.fixture";

/** The permission middleware: records what it was asked for; a test header plays the 401/403 cases. */
const requirePermissionMock = vi.hoisted(() =>
  vi.fn((_resource: string, _action: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.headers["x-test-auth"] === "none") return res.status(401).json({ error: "Authentication required" });
    if (req.headers["x-test-auth"] === "denied") return res.status(403).json({ error: "Permission denied: dropship:manage_operations" });
    (req as unknown as { session: unknown }).session = { user: { id: "staff-7" } };
    return next();
  }),
);

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: requirePermissionMock }));
vi.mock("../../infrastructure/dropship-finance.factory", () => ({
  createDropshipFinanceServiceFromEnv: () => {
    throw new Error("Route tests must inject a fake finance service");
  },
}));

import { registerDropshipAdminFinanceRoutes } from "../../interfaces/http/dropship-admin-finance.routes";

const PATH = "/api/dropship/admin/finance/summary";

/** The real service over a fake repository holding the §6.4 snapshot, so query validation is the real one. */
function realService(read: () => FinanceSummaryRead | Promise<FinanceSummaryRead> = () => ({ raw: fixtureRaw(), vendor: null, statements: [] })) {
  const repository: DropshipFinanceRepository = { readSummary: vi.fn(async () => read()) };
  const serviceLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { service: new DropshipFinanceService({ repository, clock: { now: () => FINANCE_FIXTURE_NOW }, logger: serviceLogger }), repository };
}

function routeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; cacheControl: string | null }> {
  const response = await fetch(url, { headers });
  return { status: response.status, body: await response.json().catch(() => null), cacheControl: response.headers.get("cache-control") };
}

describe("dropship admin finance routes", () => {
  let server: { url: string; close: () => Promise<void> } | null = null;
  let logger = routeLogger();

  async function serve(service: Pick<DropshipFinanceService, "getSummary">) {
    const app = express();
    registerDropshipAdminFinanceRoutes(app, service, logger);
    server = await startServer(app);
    return server.url;
  }

  beforeEach(() => {
    requirePermissionMock.mockClear();
    logger = routeLogger();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  it("guards the summary with dropship:manage_operations", async () => {
    await serve(realService().service);
    expect(requirePermissionMock).toHaveBeenCalledWith("dropship", "manage_operations");
  });

  it("serves the summary, never cached, and hands the service the raw query and the staff id", async () => {
    const { service } = realService();
    const spy = vi.spyOn(service, "getSummary");
    const url = await serve(service);
    const response = await get(`${url}${PATH}?period=mtd&compare=on`);

    expect(response.status).toBe(200);
    expect(response.cacheControl).toBe("no-store");
    expect(response.body.answer).toMatchObject({ billed: 18_730, kept: { amount: 2_641 } });
    expect(response.body.generatedAt).toBe(FINANCE_FIXTURE_NOW.toISOString());
    expect(spy).toHaveBeenCalledWith({ period: "mtd", compare: "on" }, { actorId: "staff-7" });
  });

  it.each([["none", 401], ["denied", 403]])("passes the middleware's %s answer through, still no-store", async (auth, status) => {
    const { service, repository } = realService();
    const url = await serve(service);
    const response = await get(`${url}${PATH}`, { "x-test-auth": auth });

    expect(response.status).toBe(status);
    expect(response.cacheControl).toBe("no-store");
    expect(typeof response.body.error).toBe("string");
    expect(repository.readSummary).not.toHaveBeenCalled();
  });

  it.each([
    ["period=custom", "DROPSHIP_FINANCE_INVALID_INPUT"],
    ["vendorId=abc", "DROPSHIP_FINANCE_INVALID_INPUT"],
    ["vendorId=1&vendorId=2", "DROPSHIP_FINANCE_INVALID_INPUT"],
    ["period=mtd&from=2026-10-01", "DROPSHIP_FINANCE_INVALID_INPUT"],
    ["limit=101", "DROPSHIP_FINANCE_INVALID_INPUT"],
    ["period=custom&from=2026-10-03&to=2026-10-01", "DROPSHIP_FINANCE_INVALID_PERIOD"],
    ["period=custom&from=2026-10-01&to=2026-10-09", "DROPSHIP_FINANCE_INVALID_PERIOD"],
  ])("refuses ?%s with 400 %s, a permanent error the page can word", async (query, code) => {
    const { service, repository } = realService();
    const url = await serve(service);
    const response = await get(`${url}${PATH}?${query}`);

    expect(response.status).toBe(400);
    expect(response.cacheControl).toBe("no-store");
    expect(financeErrorEnvelopeSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.error).toMatchObject({ code, context: { classification: "permanent" } });
    expect(repository.readSummary).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("dropship.finance.request_refused", expect.objectContaining({ error_code: code, actor_id: "staff-7" }));
  });

  it("tells the page why a period was refused", async () => {
    const url = await serve(realService().service);
    const response = await get(`${url}${PATH}?period=custom&from=2026-10-03&to=2026-10-01`);
    expect(response.body.error.context).toMatchObject({ classification: "permanent", reason: "from_after_to" });
  });

  it("refuses a summary that breaks the contract with 500 CONTRACT_VIOLATION and logs the issue paths only", async () => {
    const { service } = realService();
    const good = await service.getSummary({}, { actorId: null });
    const broken = structuredClone(good) as FinanceSummary;
    (broken.sections.sales.lines[0] as { amount: number }).amount = 1.5;
    const url = await serve({ getSummary: vi.fn(async () => broken) });
    const response = await get(`${url}${PATH}`);

    expect(response.status).toBe(500);
    expect(response.cacheControl).toBe("no-store");
    expect(response.body.error).toEqual({
      code: "DROPSHIP_FINANCE_CONTRACT_VIOLATION",
      message: "The finance summary did not match its contract.",
      context: { classification: "fatal" },
    });
    expect(logger.error).toHaveBeenCalledWith("dropship.finance.request_failed", expect.objectContaining({
      error_code: "DROPSHIP_FINANCE_CONTRACT_VIOLATION", error_class: "fatal", issues: expect.arrayContaining(["sections.sales.lines.0.amount"]),
    }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("1.5");
  });

  it.each([
    [new DropshipError("DROPSHIP_FINANCE_QUERY_TIMEOUT", "The finance figures took too long to read.", { stage: "transaction", sqlState: "57014" }), 503, "transient"],
    [new DropshipError("DROPSHIP_FINANCE_BUSY", "busy"), 503, "transient"],
    [new DropshipError("DROPSHIP_FINANCE_DB_UNAVAILABLE", "down"), 503, "transient"],
    [new DropshipError("DROPSHIP_FINANCE_VENDOR_NOT_FOUND", "That vendor does not exist.", { vendorId: 99 }), 404, "permanent"],
    [new DropshipError("DROPSHIP_FINANCE_INTERNAL_ERROR", "bounds differ", { database: {} }), 500, "fatal"],
  ])("maps %s to its status and class, with no database detail", async (error, status, classification) => {
    const url = await serve({ getSummary: vi.fn(async () => { throw error; }) });
    const response = await get(`${url}${PATH}`);

    expect(response.status).toBe(status);
    expect(response.cacheControl).toBe("no-store");
    expect(financeErrorEnvelopeSchema.safeParse(response.body).success).toBe(true);
    expect(response.body.error.code).toBe(error.code);
    expect(response.body.error.context.classification).toBe(classification);
    expect(response.body.error.context).not.toHaveProperty("sqlState");
    expect(response.body.error.context).not.toHaveProperty("database");
  });

  it("logs a transient failure at WARN and a fatal one at ERROR", async () => {
    let next: Error = new DropshipError("DROPSHIP_FINANCE_QUERY_TIMEOUT", "slow");
    const url = await serve({ getSummary: vi.fn(async () => { throw next; }) });
    await get(`${url}${PATH}`);
    expect(logger.warn).toHaveBeenCalledWith("dropship.finance.request_failed", expect.objectContaining({ error_class: "transient" }));
    next = new DropshipError("DROPSHIP_FINANCE_INTERNAL_ERROR", "bug");
    await get(`${url}${PATH}`);
    expect(logger.error).toHaveBeenCalledWith("dropship.finance.request_failed", expect.objectContaining({ error_class: "fatal" }));
  });

  it("answers an unexpected error as a fatal internal error, keeping the cause for the log only", async () => {
    const url = await serve({ getSummary: vi.fn(async () => { throw new TypeError("cannot read x of undefined"); }) });
    const response = await get(`${url}${PATH}`);

    expect(response.status).toBe(500);
    expect(response.body.error).toEqual({
      code: "DROPSHIP_FINANCE_INTERNAL_ERROR",
      message: "The finance figures could not be read.",
      context: { classification: "fatal" },
    });
    expect(logger.error).toHaveBeenCalledWith("dropship.finance.request_failed", expect.objectContaining({
      error_code: "DROPSHIP_FINANCE_INTERNAL_ERROR", original_code: null, error_message: "cannot read x of undefined",
    }));
  });

  it("does not answer a non-finance DropshipError with its own code", async () => {
    const url = await serve({ getSummary: vi.fn(async () => { throw new DropshipError("DROPSHIP_WALLET_ACCOUNT_NOT_FOUND", "nope"); }) });
    const response = await get(`${url}${PATH}`);
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("DROPSHIP_FINANCE_INTERNAL_ERROR");
  });

  it("routes only the summary path: summary.csv is not served by it", async () => {
    const { service, repository } = realService();
    const url = await serve(service);
    const response = await fetch(`${url}${PATH}.csv`);
    expect(response.status).toBe(404);
    expect(repository.readSummary).not.toHaveBeenCalled();
  });
});
