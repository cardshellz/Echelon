import type { Page } from "@playwright/test";

/** Transport fixture only. PostgreSQL tests exercise the real rolled-back owner
 * and exact stock/order impact; browser tests verify review-before-approval. */
export async function installInvoiceCostPreview(page: Page, lineId: number, lineTotalCents: number) {
  await page.route(`**/api/vendor-invoice-lines/${lineId}/cost-components/preview`, async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({ json: { preview: { lineId, lineTotalCents, previewVersion: "b".repeat(64), before: null,
      after: { contractVersion: 1, source: "operator_review", packagingTreatment: body.packagingTreatment, productMills: body.productMills, packagingMills: body.packagingMills, adjustmentMills: body.adjustmentMills },
      impact: { lots: [], orderCosts: [], historicalCosts: [] } }, application: null } });
  });
}

export async function approveSupplierCostReview(page: Page) {
  await page.getByRole("button", { name: "Review cost changes", exact: true }).click();
  await page.getByRole("region", { name: "Supplier cost changes", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Approve and apply costs", exact: true }).click();
}
