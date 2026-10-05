/**
 * The Program finance summary for the contract §6.4 seeded program
 * (scratchpad finance-contract.md §6.4): "This month so far" on
 * 2026-10-05 at 9:14 AM Eastern, all vendors, compared with Sep 1 – 5.
 *
 * It is the server's real output, not a hand-written copy: the golden file
 * shared/dropship/__tests__/fixtures/program-finance-summary.golden.json is
 * buildFinanceSummary(fixtureRaw(), fixtureContext()) parsed by the shared
 * contract, written by
 *
 *   npx tsx server/modules/dropship/__tests__/fixtures/write-program-finance-golden.ts
 *
 * and kept equal to the server by
 * server/modules/dropship/__tests__/unit/program-finance-golden.test.ts. So a
 * server change that alters what the page receives fails there first, and the
 * page's tests always run on the summary the server really sends.
 *
 * Shared by the model and panel tests and by the browser journeys, which serve
 * `financeSummaryFixtureInput()` as the JSON body as is. Variants (a loss, a
 * failed section, last month, …) are built from this in the tests that need
 * them, and every variant goes back through the contract before use.
 *
 * Each call returns a fresh copy, so a test may mutate its own.
 */

import type { z } from "zod";
import {
  financeLineSchema,
  financeSummarySchema,
  type FinanceCheckId,
  type FinanceSummary,
  type FinanceSummaryInput,
} from "@shared/dropship/program-finance";
import goldenSummaryJson from "@shared/dropship/__tests__/fixtures/program-finance-summary.golden.json" with { type: "json" };

type LineInput = z.input<typeof financeLineSchema>;
type CheckInput = FinanceSummaryInput["checks"][number];

/** Parses a (possibly mutated) fixture, naming every contract issue when it no longer fits. */
export function parseFinanceFixture(input: FinanceSummaryInput): FinanceSummary {
  return parseSummary(input);
}

function parseSummary(input: unknown): FinanceSummary {
  const parsed = financeSummarySchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`the finance summary fixture breaks the contract:\n${issues.join("\n")}`);
  }
  return parsed.data;
}

/** The golden, checked against the contract once when the fixture loads. */
const GOLDEN: FinanceSummary = Object.freeze(parseSummary(goldenSummaryJson));

/** The injected clock of the §6.4 run: Oct 5, 2026, 9:14 AM Eastern. */
export const FINANCE_FIXTURE_GENERATED_AT: string = GOLDEN.generatedAt;
/** The checks the §6.4 seed leaves needing a look (D6, K2, N1 and N2); the others are fine. */
export const FINANCE_FIXTURE_CHECKS_NEEDING_A_LOOK: readonly FinanceCheckId[] = Object.freeze(
  GOLDEN.checks.filter((check) => check.result === "needs_a_look").map((check) => check.id),
);

/** A statement line for a variant, with the defaults the server uses for a recorded line. */
export function financeFixtureLine(key: string, amount: number | null, extra: Partial<LineInput> = {}): LineInput {
  return { key, operator: "none", amount, unit: "cents", status: "recorded", datedBy: "accepted", depth: "summary", ...extra };
}

/** One check as the golden has it, with a variant's changes on top. */
export function financeFixtureCheck(id: FinanceCheckId, overrides: Partial<CheckInput> = {}): CheckInput {
  const golden = GOLDEN.checks.find((check) => check.id === id);
  if (!golden) throw new Error(`the golden summary has no check ${id}`);
  return { ...structuredClone(golden), ...overrides };
}

/** The §6.4 summary as the server hands it to the page (JSON-ready, instants as ISO text). */
export function financeSummaryFixtureInput(): FinanceSummaryInput {
  return structuredClone(GOLDEN);
}

/** The §6.4 summary as the page receives it (parsed by the shared contract). */
export function financeSummaryFixture(): FinanceSummary {
  return parseFinanceFixture(financeSummaryFixtureInput());
}
