import { expect, test, type Page } from "@playwright/test";
import { installFixtures } from "./procurement-fixtures";
import {
  receiptInvoiceContextSchema,
  receiptInvoicePreviewSchema,
  type ReceiptInvoiceAllocation,
} from "../../shared/procurement/receipt-invoice-costs";

const receipts = [
  {
    receivingLineId: 101,
    receiptId: 11,
    receiptNumber: "RCV-A",
    startBasePiece: 0,
    pieces: 100,
  },
  {
    receivingLineId: 102,
    receiptId: 12,
    receiptNumber: "RCV-B",
    startBasePiece: 100,
    pieces: 100,
  },
];
const assigned: ReceiptInvoiceAllocation[] = [
  {
    receivingLineId: 101,
    invoiceLineId: 72,
    receiptStartPiece: 0,
    invoiceStartPiece: 0,
    pieces: 100,
  },
  {
    receivingLineId: 102,
    invoiceLineId: 82,
    receiptStartPiece: 0,
    invoiceStartPiece: 0,
    pieces: 100,
  },
];
const before = receipts.map((row) => ({
  ...row,
  confirmedPieces: 0,
  provisionalPieces: 100,
  supplierMills: 1100000,
}));
async function setup(
  page: Page,
  options: {
    canApprove?: boolean;
    lost?: boolean;
    denial?: "terminal" | "middleware";
    stale?: boolean;
    saved?: boolean;
  } = {},
) {
  const failures = await installFixtures(page),
    writes: Array<{ key: string; body: unknown }> = [];
  let lost = options.lost,
    denial = options.denial,
    stale = options.stale,
    measured: ReturnType<typeof receiptInvoicePreviewSchema.parse>;
  const context = receiptInvoiceContextSchema.parse({
    purchaseOrderLineId: 18,
    purchaseOrderId: 17,
    label: "Test goods",
    sourceVersion: "a".repeat(64),
    canApprove: options.canApprove ?? true,
    enabled: options.saved ?? false,
    allocations: options.saved ? assigned : [],
    receipts,
    costs: before,
    invoices: [
      {
        id: 72,
        invoiceId: 71,
        invoiceNumber: "INVOICE-A",
        pieces: 100,
        amountCents: 13000,
        ready: true,
      },
      {
        id: 82,
        invoiceId: 81,
        invoiceNumber: "INVOICE-B",
        pieces: 100,
        amountCents: 17000,
        ready: true,
      },
    ],
    approvals: [],
  });
  function preview(allocations: ReceiptInvoiceAllocation[]) {
    return receiptInvoicePreviewSchema.parse({
      sourceVersion: context.sourceVersion,
      previewVersion: "b".repeat(64),
      change: { purchaseOrderLineId: 18, allocations },
      before,
      after: receipts.map((row, index) => {
        const covered = allocations
          .filter((item) => item.receivingLineId === row.receivingLineId)
          .reduce((sum, item) => sum + item.pieces, 0);
        return {
          ...row,
          confirmedPieces: covered,
          provisionalPieces: 100 - covered,
          supplierMills: 1100000 + covered * (index === 0 ? 2000 : 6000),
        };
      }),
      unassignedInvoicePieces:
        200 - allocations.reduce((sum, row) => sum + row.pieces, 0),
      impact: { lots: [], orderCosts: [], historicalCosts: [] },
      inventoryValues: [
        {
          lotId: 7,
          lotNumber: "RECEIVED-A",
          onHandUnits: 2,
          beforeMills: 1100000,
          afterMills: 1300000,
          reviewReason: null,
        },
      ],
      issues: [],
    });
  }
  if (options.saved) {
    context.costs = preview(assigned).after;
    context.approvals = [
      {
        actorName: "Purchasing administrator",
        approvedAt: "2026-11-01T12:00:00.000Z",
        reason: "Checked supplier invoices against the two receiving batches",
        preview: preview(assigned),
      },
    ];
  }
  await page.route("**/api/purchasing/receipt-invoice-costs/18", (route) =>
    route.fulfill({ json: context }),
  );
  await page.route(
    "**/api/purchasing/receipt-invoice-costs/preview",
    (route) => {
      if (stale)
        return route.fulfill({
          status: 409,
          json: {
            error: "The receipt or invoice changed. Reload the cost review.",
            code: "RECEIPT_INVOICE_STALE",
          },
        });
      measured = preview(route.request().postDataJSON().change.allocations);
      return route.fulfill({ json: measured });
    },
  );
  await page.route("**/api/purchasing/receipt-invoice-costs", (route) => {
    writes.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postDataJSON(),
    });
    if (denial)
      return route.fulfill({
        status: 403,
        ...(denial === "terminal"
          ? { headers: { "Idempotency-Replayed": "false" } }
          : {}),
        json: {
          error: "Administrator approval is required.",
          code: "INVOICE_QUANTITY_ADMIN_REQUIRED",
        },
      });
    if (lost) return route.abort("failed");
    return route.fulfill({ json: { auditEventId: 421, preview: measured } });
  });
  await page.route("**/api/vendor-invoices/71", (route) =>
    route.fulfill({
      json: {
        id: 71,
        invoiceNumber: "INVOICE-A",
        vendorId: 2,
        status: "approved",
        currency: "USD",
        invoicedAmountCents: 13000,
        paidAmountCents: 0,
        balanceCents: 13000,
        lines: [
          {
            id: 72,
            lineNumber: 1,
            purchaseOrderLineId: 18,
            productName: "Test goods",
            qtyInvoiced: 100,
            qtyOrdered: 200,
            qtyReceived: 200,
            unitCostCents: 120,
            unitCostMills: 12000,
            lineTotalCents: 13000,
          },
        ],
        poLinks: [{ purchaseOrderId: 17, poNumber: "TEST-PO-17" }],
        attachments: [],
        payments: [],
      },
    }),
  );
  await page.goto("/ap-invoices/71?tab=lines");
  await page
    .getByRole("button", { name: "Receipt invoice costs", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Test goods", exact: true }),
  ).toBeVisible();
  return {
    dialog,
    writes,
    failures,
    release: () => {
      lost = false;
      denial = undefined;
      stale = false;
    },
  };
}
async function prepare(page: Page, two = true) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Add invoice assignment", exact: true })
    .click();
  if (two)
    await dialog
      .getByRole("button", { name: "Add invoice assignment", exact: true })
      .click();
  await dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Reason / supplier reference", { exact: true }),
  ).toBeVisible();
}
async function approve(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Reason / supplier reference", { exact: true })
    .fill("Checked these invoices against the received batches");
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Approve & update costs", exact: true })
    .click();
}

test("assigns distinct invoices with compact before/after and one approval", async ({
  page,
}, info) => {
  const proof = await setup(page);
  await prepare(page);
  await expect(
    proof.dialog.getByRole("table", {
      name: "RCV-A before and after",
      exact: true,
    }),
  ).toContainText("$130.00");
  await expect(
    proof.dialog.getByRole("table", {
      name: "RCV-B before and after",
      exact: true,
    }),
  ).toContainText("$170.00");
  expect(proof.writes).toEqual([]);
  await proof.dialog.screenshot({
    path: info.outputPath("receipt-cost-before-after.png"),
  });
  await approve(page);
  await expect(proof.dialog.getByRole("status")).toContainText(
    "Assignment approved and saved",
  );
  expect(proof.writes).toHaveLength(1);
  expect(proof.writes[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(proof.failures).toEqual([]);
});
test("leaves an unassigned receipt visibly provisional", async ({ page }) => {
  const { dialog } = await setup(page);
  await prepare(page, false);
  const second = dialog.getByRole("table", {
    name: "RCV-B before and after",
    exact: true,
  });
  await expect(second).toContainText("$110.00");
  await expect(second).toContainText("Pieces at provisional PO cost");
  await expect(dialog).toContainText("100 invoiced pieces are not assigned");
});
test("allows a partial received batch with explicit overrides", async ({
  page,
}) => {
  const { dialog } = await setup(page);
  await dialog
    .getByRole("button", { name: "Add invoice assignment", exact: true })
    .click();
  await dialog.getByLabel("Pieces covered 1", { exact: true }).fill("50");
  await dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("table", { name: "RCV-A before and after", exact: true }),
  ).toContainText("$120.00");
  await dialog
    .getByRole("button", { name: "Edit assignments", exact: true })
    .click();
  await expect(
    dialog.getByLabel("Pieces covered 1", { exact: true }),
  ).toHaveValue("50");
});
test("requires current administrator authority and explicit confirmation", async ({
  page,
}) => {
  const { dialog, writes } = await setup(page, { canApprove: false });
  await dialog
    .getByRole("button", { name: "Add invoice assignment", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Review changes", exact: true }),
  ).toBeDisabled();
  await expect(dialog).toContainText(
    "An Administrator with purchasing approval permission",
  );
  expect(writes).toEqual([]);
});
test("preserves the reviewed key after a lost response and reopening", async ({
  page,
}) => {
  const proof = await setup(page, { lost: true });
  await prepare(page);
  await approve(page);
  await expect(
    proof.dialog.getByRole("button", {
      name: "Retry saved approval",
      exact: true,
    }),
  ).toBeEnabled({ timeout: 30_000 });
  const original = proof.writes[0].key;
  await proof.dialog
    .getByRole("button", { name: "Close", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Receipt invoice costs", exact: true })
    .click();
  await expect(
    proof.dialog.getByRole("button", {
      name: "Retry saved approval",
      exact: true,
    }),
  ).toBeEnabled();
  proof.release();
  await proof.dialog
    .getByRole("button", { name: "Retry saved approval", exact: true })
    .click();
  await expect(proof.dialog.getByRole("status")).toContainText(
    "Assignment approved and saved",
  );
  expect(new Set(proof.writes.map((row) => row.key))).toEqual(
    new Set([original]),
  );
});
test("keeps an unresolved permission outcome on the original key", async ({
  page,
}) => {
  const proof = await setup(page, { denial: "middleware" });
  await prepare(page);
  await approve(page);
  await expect(
    proof.dialog.getByRole("button", {
      name: "Retry saved approval",
      exact: true,
    }),
  ).toBeEnabled();
  const original = proof.writes[0].key;
  proof.release();
  await proof.dialog
    .getByRole("button", { name: "Retry saved approval", exact: true })
    .click();
  await expect(proof.dialog.getByRole("status")).toContainText(
    "Assignment approved and saved",
  );
  expect(proof.writes.map((row) => row.key)).toEqual([original, original]);
});
test("requires a fresh review after a recorded authority rejection", async ({
  page,
}) => {
  const proof = await setup(page, { denial: "terminal" });
  await prepare(page);
  await approve(page);
  await expect(
    proof.dialog.getByRole("button", {
      name: "Reload cost review",
      exact: true,
    }),
  ).toBeVisible();
  const original = proof.writes[0].key;
  proof.release();
  await proof.dialog
    .getByRole("button", { name: "Reload cost review", exact: true })
    .click();
  await prepare(page);
  await approve(page);
  await expect(proof.dialog.getByRole("status")).toContainText(
    "Assignment approved and saved",
  );
  expect(proof.writes[1].key).not.toBe(original);
});
test("rejects a stale preview without sending an approval", async ({
  page,
}) => {
  const proof = await setup(page, { stale: true });
  await proof.dialog
    .getByRole("button", { name: "Add invoice assignment", exact: true })
    .click();
  await proof.dialog
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(
    proof.dialog.getByRole("button", {
      name: "Reload cost review",
      exact: true,
    }),
  ).toBeVisible();
  expect(proof.writes).toEqual([]);
});
test("shows existing approval details instead of an approval button for unchanged costs", async ({
  page,
}) => {
  const proof = await setup(page, { saved: true });
  await expect(proof.dialog).toContainText(
    "These are the saved receipt assignments",
  );
  await expect(
    proof.dialog.getByRole("button", {
      name: "Approve & update costs",
      exact: true,
    }),
  ).toHaveCount(0);
  await proof.dialog
    .locator("summary")
    .filter({ hasText: "Previous approvals" })
    .click();
  await proof.dialog
    .locator("summary")
    .filter({ hasText: "Purchasing administrator" })
    .click();
  await expect(
    proof.dialog.getByRole("table", {
      name: "RCV-A before and after",
      exact: true,
    }),
  ).toContainText("$130.00");
  expect(proof.writes).toEqual([]);
});
