import http from "http";
import { AddressInfo } from "net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DropshipCostChangeNoticeService } from "../../application/dropship-cost-change-notice-service";
import { DropshipError } from "../../domain/errors";
import { registerDropshipCostChangeRoutes, statusForVendorCostChangeError } from "../../interfaces/http/dropship-cost-change.routes";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const authCalls: string[] = [];
vi.mock("../../interfaces/http/dropship-auth.routes", () => ({
  requireDropshipAuth: (req: Request, _res: Response, next: NextFunction) => {
    authCalls.push(req.path);
    // The route reads only `session.dropship.memberId`; the rest of the principal is irrelevant here.
    req.session = { dropship: { memberId: "member-5" } } as unknown as Request["session"];
    next();
  },
  requireDropshipSensitiveActionProof: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

describe("dropship vendor cost change routes", () => {
  let server: { url: string; close: () => Promise<void> };
  let service: FakeService;

  beforeEach(async () => {
    authCalls.length = 0;
    service = new FakeService();
    const app = express();
    registerDropshipCostChangeRoutes(app, service as unknown as DropshipCostChangeNoticeService);
    server = await startServer(app);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.close();
  });

  it("serves the signed-in vendor's own view behind the vendor session", async () => {
    const response = await jsonRequest(`${server.url}/api/dropship/cost-changes`);
    expect(response.status).toBe(200);
    expect(authCalls).toEqual(["/api/dropship/cost-changes"]);
    expect(service.members).toEqual(["member-5"]);
    expect(response.body).toMatchObject({ announced: [], recent: [], policy: { increaseNoticeDays: 14 }, generatedAt: "2026-09-28T16:05:00.000Z" });
  });

  it("maps classified errors and hides unexpected ones", async () => {
    service.fail = new DropshipError("DROPSHIP_COST_SCHEDULE_TABLE_MISSING", "not yet", { classification: "transient" });
    expect((await jsonRequest(`${server.url}/api/dropship/cost-changes`)).status).toBe(503);
    service.fail = new DropshipError("DROPSHIP_ENTITLEMENT_REQUIRED", "no", {});
    expect((await jsonRequest(`${server.url}/api/dropship/cost-changes`)).status).toBe(403);
    service.fail = new Error("boom");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await jsonRequest(`${server.url}/api/dropship/cost-changes`);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: "DROPSHIP_COST_CHANGE_INTERNAL_ERROR", message: "Dropship cost change request failed." } });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("knows the status of every error it can produce", () => {
    expect(statusForVendorCostChangeError("DROPSHIP_COST_CHANGE_INVALID_INPUT")).toBe(400);
    expect(statusForVendorCostChangeError("DROPSHIP_ENTITLEMENT_INACTIVE")).toBe(403);
    expect(statusForVendorCostChangeError("DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING")).toBe(503);
    expect(statusForVendorCostChangeError("DROPSHIP_COST_SCHEDULE_INVALID_STORED_VALUE")).toBe(500);
  });
});

class FakeService {
  members: string[] = [];
  fail: Error | null = null;
  async getVendorViewForMember(memberId: string) {
    this.members.push(memberId);
    if (this.fail) throw this.fail;
    return {
      announced: [], recent: [],
      policy: { increaseNoticeDays: 14, decreaseTiming: "immediate", priceProtection: true, notifyByEmail: true, notifyInPortal: true, notifyOnDecrease: true },
      generatedAt: new Date("2026-09-28T16:05:00.000Z"),
    };
  }
}

async function startServer(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function jsonRequest(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
