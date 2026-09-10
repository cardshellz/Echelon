import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCostLotsReport, CostReportResponseError } from "@shared/inventory/cost-report-read";
import { costReportErrorMessage, CostReportRequestError, readCostReport } from "../../cost-report-read";

afterEach(() => vi.unstubAllGlobals());

describe("cost report read requests", () => {
  it("sends session credentials and cancellation through the validated read", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ lots: [], total: 0 })));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await expect(readCostReport("/api/cogs/lots", parseCostLotsReport, signal)).resolves.toEqual({ lots: [], total: 0 });
    expect(fetch).toHaveBeenCalledWith("/api/cogs/lots", { credentials: "include", signal });
  });

  it("classifies a failed request without displaying the server response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private SQL detail", { status: 500 })));
    const request = readCostReport("/api/cogs/lots", parseCostLotsReport, new AbortController().signal);
    await expect(request).rejects.toMatchObject({ code: "COST_REPORT_REQUEST_FAILED", status: 500 });
    expect(costReportErrorMessage(new CostReportRequestError(500))).not.toContain("private SQL");
  });

  it.each(["not JSON", "{}", "null"])("classifies malformed success %s", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(readCostReport("/api/cogs/lots", parseCostLotsReport, new AbortController().signal)).rejects.toBeInstanceOf(CostReportResponseError);
  });

  it("shows a safe retry message for network failures", () => {
    expect(costReportErrorMessage(new TypeError("private fetch detail"))).toBe("The report could not be loaded. Check your connection and retry.");
  });
});
