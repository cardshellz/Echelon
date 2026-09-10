import { CostReportResponseError } from "@shared/inventory/cost-report-read";

export class CostReportRequestError extends Error {
  readonly code = "COST_REPORT_REQUEST_FAILED";

  constructor(readonly status: number) {
    super(`The report could not be loaded (HTTP ${status}). Retry to load it again.`);
    this.name = "CostReportRequestError";
  }
}

export async function readCostReport<T>(
  url: string,
  parse: (value: unknown) => T,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(url, { credentials: "include", signal });
  if (!response.ok) throw new CostReportRequestError(response.status);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    // Do not echo an upstream HTML page or raw server error into the UI.
    throw new CostReportResponseError(url.includes("valuation") ? "valuation" : "lots", ["response"]);
  }
  return parse(value);
}

export function costReportErrorMessage(error: unknown): string {
  return error instanceof CostReportRequestError || error instanceof CostReportResponseError
    ? error.message
    : "The report could not be loaded. Check your connection and retry.";
}
