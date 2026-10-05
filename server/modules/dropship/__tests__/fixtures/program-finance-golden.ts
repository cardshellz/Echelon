/**
 * The one golden Program finance summary: the server's real output for the
 * contract §6.4 seeded program (fixtureRaw() at fixtureContext(): "This
 * month so far" on Oct 5, 2026, 9:14 AM Eastern, all vendors, compared with
 * Sep 1 – 5), parsed by the shared contract and round-tripped through JSON,
 * exactly as the page receives it.
 *
 * It is written to shared/dropship/__tests__/fixtures/program-finance-summary.golden.json
 * by write-program-finance-golden.ts, never by hand. The client's model,
 * panel and browser tests serve that file, and
 * server/modules/dropship/__tests__/unit/program-finance-golden.test.ts fails
 * whenever the server's output and the file disagree, so the page's tests can
 * no longer drift from what the server sends.
 */

import { financeSummarySchema } from "../../../../../shared/dropship/program-finance";
import { buildFinanceSummary } from "../../domain/program-finance-statement";
import { fixtureContext, fixtureRaw } from "./program-finance-raw.fixture";

/** Where the golden lives, relative to the repository root. */
export const FINANCE_GOLDEN_SUMMARY_PATH = "shared/dropship/__tests__/fixtures/program-finance-summary.golden.json";
/** The command that rewrites the golden from the server's current output. */
export const FINANCE_GOLDEN_REGENERATE_COMMAND = "npx tsx server/modules/dropship/__tests__/fixtures/write-program-finance-golden.ts";

/** The §6.4 summary as JSON-ready data: what the route would send, after the contract has parsed it. */
export function goldenFinanceSummaryJson(): unknown {
  return JSON.parse(JSON.stringify(financeSummarySchema.parse(buildFinanceSummary(fixtureRaw(), fixtureContext()))));
}

/** The golden file's exact text: two-space JSON with a final newline. */
export function goldenFinanceSummaryText(): string {
  return `${JSON.stringify(goldenFinanceSummaryJson(), null, 2)}\n`;
}
