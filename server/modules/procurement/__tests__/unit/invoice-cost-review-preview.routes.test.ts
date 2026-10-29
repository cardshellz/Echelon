import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) => (req: Request, res: Response, next: NextFunction) => {
  if (req.headers["x-test-permission"] !== `${resource}:${action}`) return res.status(403).json({ error: "Permission denied" }); next();
} }));
import { registerInvoiceCostReviewPreviewRoute } from "../../invoice-cost-review-preview.routes";
import { ApLedgerError } from "../../ap-ledger.service";
import { CostEvidenceError } from "../../../inventory/infrastructure/cost-evidence-values";

describe("invoice cost preview HTTP boundary", () => {
  let server: http.Server, base: string;
  const preview = vi.fn();
  beforeEach(async () => {
    vi.resetAllMocks(); const app = express(); app.use(express.json());
    app.use((req, _res, next) => { if (req.headers["x-test-actor"]) (req as Request & { user?: { id: string } }).user = { id: String(req.headers["x-test-actor"]) }; next(); });
    registerInvoiceCostReviewPreviewRoute(app, preview);
    server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); vi.restoreAllMocks(); });
  const call = (id = "72", permission = "purchasing:approve", actor = "approver") => requestLocalHttp(`${base}/api/vendor-invoice-lines/${id}/cost-components/preview`, {
    method: "POST", headers: { "content-type": "application/json", "x-test-permission": permission, "x-test-actor": actor }, body: JSON.stringify({ saved: "review" }),
  });
  it("requires purchasing approval and an authenticated actor before the cost owner runs", async () => {
    expect((await call("72", "purchasing:view")).status).toBe(403);
    expect((await call("72", "purchasing:approve", "")).status).toBe(401); expect(preview).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "1.5", "72x", "00072", "2147483648"])("rejects invalid line identifier %s", async id => {
    expect((await call(id)).status).toBe(400); expect(preview).not.toHaveBeenCalled();
  });
  it("passes only the validated line and authenticated actor into the preview service", async () => {
    preview.mockResolvedValue({ preview: "verified owner response" });
    expect(await (await call()).json()).toEqual({ preview: "verified owner response" });
    expect(preview).toHaveBeenCalledExactlyOnceWith(72, { saved: "review" }, "approver");
  });
  it("keeps stale evidence and incomplete history actionable without exposing database errors", async () => {
    preview.mockRejectedValueOnce(new ApLedgerError("Reload the changed invoice.", 409, { code: "INVOICE_COST_REVIEW_STALE" }));
    const stale = await call(); expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ details: { code: "INVOICE_COST_REVIEW_STALE" } });
    preview.mockRejectedValueOnce(new CostEvidenceError("COST_RECONCILIATION_PARTIAL_HISTORY", "Complete the receipt history before replacing its historical cost."));
    expect((await call()).status).toBe(409);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    preview.mockRejectedValueOnce(new Error("private database connection"));
    const failure = await call(); expect(failure.status).toBe(503); expect(await failure.text()).not.toContain("private database");
    expect(logged).toHaveBeenCalledWith(expect.not.stringContaining("private database"));
  });
});
