import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { financeSummarySchema } from "../../../../../shared/dropship/program-finance";
import {
  FINANCE_GOLDEN_REGENERATE_COMMAND,
  FINANCE_GOLDEN_SUMMARY_PATH,
  goldenFinanceSummaryJson,
  goldenFinanceSummaryText,
} from "../fixtures/program-finance-golden";

// The page's tests (model, panel and browser journeys) serve the golden
// summary as the server's answer for the §6.4 program. This test keeps that
// file equal to what buildFinanceSummary really produces, so the client tests
// can never pass on a summary the server does not send.
//
// When this fails after a deliberate server or contract change, regenerate the
// golden and run the client finance tests against it:
//
//   npx tsx server/modules/dropship/__tests__/fixtures/write-program-finance-golden.ts

const goldenText = readFileSync(resolve(process.cwd(), FINANCE_GOLDEN_SUMMARY_PATH), "utf8");

describe("the golden Program finance summary", () => {
  it("is exactly the server's output for the §6.4 raw fixture", () => {
    expect(JSON.parse(goldenText), `regenerate it with: ${FINANCE_GOLDEN_REGENERATE_COMMAND}`).toEqual(goldenFinanceSummaryJson());
  });

  it("is the generator's text byte for byte, so nobody edits it by hand", () => {
    expect(goldenText, `regenerate it with: ${FINANCE_GOLDEN_REGENERATE_COMMAND}`).toBe(goldenFinanceSummaryText());
  });

  it("is valid against the shared contract and unchanged by parsing it again", () => {
    const golden: unknown = JSON.parse(goldenText);
    const parsed = financeSummarySchema.safeParse(golden);
    expect(parsed.success).toBe(true);
    expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(golden);
  });

  it("carries the figures the client tests rely on", () => {
    const golden = financeSummarySchema.parse(JSON.parse(goldenText));
    expect(golden.answer).toMatchObject({ status: "ok", state: "kept", kept: { amount: 2_641, status: "recorded" }, keptOnOrders: 3_881 });
    const steps = golden.answer.workings.map((step) => [step.textKey, step.result, step.resultUnit]);
    expect(steps).toContainEqual(["working.margin_share", 399, "share_tenths"]);
    expect(steps).toContainEqual(["working.margin_prior", 404, "share_tenths"]);
    expect(steps).toContainEqual(["working.margin_change", -5, "share_change_tenths"]);
    const deposits = golden.sections.cash.lines.find((line) => line.key === "cash.received_deposits");
    expect(deposits).toMatchObject({ amount: 90_300, count: 4 });
  });
});
