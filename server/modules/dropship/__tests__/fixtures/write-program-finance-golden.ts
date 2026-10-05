/**
 * Rewrites the golden Program finance summary from the server's current
 * output (see program-finance-golden.ts). Run it after any change to the
 * finance statement, the raw fixture or the shared contract:
 *
 *   npx tsx server/modules/dropship/__tests__/fixtures/write-program-finance-golden.ts
 *
 * then run the client finance tests and journeys, which serve the new file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { FINANCE_GOLDEN_SUMMARY_PATH, goldenFinanceSummaryText } from "./program-finance-golden";

const target = resolve(process.cwd(), FINANCE_GOLDEN_SUMMARY_PATH);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, goldenFinanceSummaryText(), "utf8");
process.stdout.write(`wrote ${FINANCE_GOLDEN_SUMMARY_PATH}\n`);
