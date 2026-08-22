import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const PANEL_SOURCE = readFileSync(
  resolve(process.cwd(), "client/src/components/returns/ReturnCaseAdminPanel.tsx"),
  "utf8",
);

describe("return case operational panel contract", () => {
  it("loads validated operational detail and passes the server action plan to the operations card", () => {
    expect(PANEL_SOURCE).toContain('getReturnCaseDetail(selectedCaseId)');
    expect(PANEL_SOURCE).toContain('<ReturnCaseOperationsCard');
    expect(PANEL_SOURCE).toContain('actionPlan={detail.actionPlan}');
    expect(PANEL_SOURCE).toContain('items={detail.items}');

    const operationsPosition = PANEL_SOURCE.indexOf('<ReturnCaseOperationsCard');
    const lifecyclePosition = PANEL_SOURCE.indexOf('>Lifecycle</h3>');
    expect(operationsPosition).toBeGreaterThan(-1);
    expect(lifecyclePosition).toBeGreaterThan(operationsPosition);
  });

  it("does not derive operation eligibility from lifecycle display statuses", () => {
    const detailBodyStart = PANEL_SOURCE.indexOf('function ReturnCaseDetailBody');
    const detailBodyEnd = PANEL_SOURCE.indexOf('function SummaryCard', detailBodyStart);
    const detailBody = PANEL_SOURCE.slice(detailBodyStart, detailBodyEnd);

    expect(detailBody).not.toMatch(
      /detail\.(?:approvalStatus|logisticsStatus|inspectionStatus)\s*===/,
    );
    expect(detailBody).not.toMatch(/\b(?:canRecordReceipt|canStartInspection)\b/);
  });

  it("invalidates the active detail and list after an operation completes", () => {
    expect(PANEL_SOURCE).toContain(
      'queryClient.invalidateQueries({ queryKey: ["return-case", caseId], exact: true })',
    );
    expect(PANEL_SOURCE).toContain(
      'queryClient.invalidateQueries({ queryKey: ["return-cases"] })',
    );
    expect(PANEL_SOURCE).toContain('onOperationCompleted={refreshReturnCase}');
  });
});
