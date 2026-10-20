import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, type QueryKey } from "@tanstack/react-query";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { supplierCreditDetailSchema, supplierCreditListSchema, type SupplierCreditDetail as Credit } from "@shared/procurement/supplier-credit";
import { invoiceWorkListPageSchema } from "@shared/procurement/ap-work-list";
import { AuthProvider } from "@/lib/auth";
import SupplierCredits from "@/pages/SupplierCredits";
import { SupplierCreditCreate } from "../../SupplierCreditCreate";
import { SupplierCreditDetail } from "../../SupplierCreditDetail";
import { SupplierCreditRecovery } from "../../SupplierCreditRecovery";
import { invoiceWorkListQuery } from "../../ap-work-list-query";
import type { SupplierCreditCommands } from "../../use-supplier-credit-commands";

const actorId = "credit-render-operator";
const version = "a".repeat(64);
const allowed = { allowed: true, code: "ALLOWED", reason: "Reviewed source permits this action." };
const unavailable = { allowed: false, code: "UNAVAILABLE", reason: "This action is unavailable in the current credit state." };
const detailKey = ["/api/supplier-credits/9", actorId];
const listKey = ["/api/supplier-credits", "limit=20&offset=0", null];

function commands(overrides: Partial<SupplierCreditCommands> = {}): SupplierCreditCommands {
  return {
    userId: actorId, canCreate: true, canApprove: true, recovery: null, storageError: null,
    confirmed: null, pending: false, error: null, blocked: false, recoverAllowed: false,
    refresh: () => { throw new Error("Rendering must not refresh recovery storage."); },
    recover: () => { throw new Error("Rendering must not execute a recovered command."); },
    execute: async () => { throw new Error("Rendering must not execute a financial command."); },
    ...overrides,
  };
}

function credit(overrides: Partial<Credit> = {}): Credit {
  return supplierCreditDetailSchema.parse({
    id: 9, sourceInvoiceId: 71, sourceInvoiceNumber: "INV-071", vendorId: 3,
    vendorName: "Example Supplier", currency: "USD", supplierReference: "CREDIT-009",
    creditCalendarDate: "2026-10-19", reason: "Supplier confirmed a product price reduction.",
    status: "approved", version, replacesCreditId: null, replacedByCreditId: null,
    totalAmountCents: 10000, appliedAmountCents: 2500, unappliedAmountCents: 7500,
    balanceState: "available", balanceIssues: [], costStatus: "review_required",
    costIssues: [{ code: "COST_REVIEW", message: "Recorded source cost requires accounting review." }],
    createdBy: actorId, createdAt: "2026-10-19T12:00:00.000Z",
    approvedBy: actorId, approvedAt: "2026-10-19T12:05:00.000Z",
    voidedBy: null, voidedAt: null, voidReason: null,
    lines: [{ id: 91, invoiceLineId: 711, label: "Product price reduction", amountCents: 10000,
      disposition: { kind: "price_reduction", component: "product" }, sourceEvidence: {},
      costState: "review_required", costIssues: [] }],
    applications: [{ id: 19, vendorInvoiceId: 72, invoiceNumber: "INV-072", appliedAmountCents: 2500,
      actorId, recordedAt: "2026-10-19T12:10:00.000Z", reason: "Apply existing supplier credit.",
      reversal: null, canReverse: allowed }],
    capabilities: { approve: unavailable, apply: allowed, void: unavailable, replace: unavailable },
    ...overrides,
  });
}

const invoicePage = invoiceWorkListPageSchema.parse({
  items: [{ id: 71, vendorId: 3, invoiceNumber: "INV-071", ourReference: null,
    vendorName: "Example Supplier", vendorCode: "EXAMPLE", status: "approved",
    invoiceDate: "2026-10-19T00:00:00.000Z", dueDate: null,
    invoicedAmountCents: 20000, paidAmountCents: 0, creditedAmountCents: 0, settledAmountCents: 0,
    balanceCents: 20000, inboundShipmentId: null, currency: "USD", poNumbers: [] }],
  total: 1, limit: 20, offset: 0, nextOffset: null,
});

function setQueryError(client: QueryClient, queryKey: QueryKey): void {
  client.getQueryCache().build(client, { queryKey }).setState({
    status: "error", fetchStatus: "idle", error: new Error("503: Service unavailable"),
  });
}

// Exercise the real components under the same Node/JSX transform as CI. Effects do
// not run during static rendering, so these checks cannot send financial commands.
function render(component: ReactElement, seed: (client: QueryClient) => void = () => undefined,
  href = "/supplier-credits"): string {
  const client = new QueryClient({ defaultOptions: {
    queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity },
  } });
  const url = new URL(href, "https://echelon.test");
  seed(client);
  try {
    return renderToStaticMarkup(createElement(Router, {
      ssrPath: url.pathname, ssrSearch: url.search,
      children: createElement(QueryClientProvider, { client,
        children: createElement(AuthProvider, { children: component }),
      }),
    }));
  } finally { client.clear(); }
}

function createCreditForm() {
  return createElement(SupplierCreditCreate, {
    commands: commands(), initialInvoiceId: null, returnDispositionId: null,
    replacesCreditId: null, onCancel: () => undefined,
  });
}

describe("supplier credit real component rendering", () => {
  it("keeps an idle recovery panel empty", () => {
    expect(render(createElement(SupplierCreditRecovery, { commands: commands() }))).toBe("");
  });

  it("renders a recovery-storage failure with an actionable retry", () => {
    const markup = render(createElement(SupplierCreditRecovery, { commands: commands({
      storageError: "Saved supplier credit request cannot be read.", blocked: true,
    }) }));
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Saved supplier credit request cannot be read.");
    expect(markup).toContain("Retry credit recovery storage");
  });

  it("renders a confirmed rejection without inventing a saved request", () => {
    const markup = render(createElement(SupplierCreditRecovery, { commands: commands({ error: "Credit source changed. Review its current evidence." }) }));
    expect(markup).toContain("Credit source changed. Review its current evidence.");
    expect(markup).not.toContain("Recover saved credit request");
  });

  it("renders a saved create command with its exact document evidence", () => {
    const markup = render(createElement(SupplierCreditRecovery, { commands: commands({
      blocked: true, recoverAllowed: true,
      recovery: { version: 1, userId: actorId, key: "credit-render-key", body: {
        command: "create", payload: { sourceInvoiceId: 71, expectedSourceVersion: version,
          supplierReference: "CREDIT-009", creditCalendarDate: "2026-10-19", reason: "Recorded supplier document.",
          lines: [{ invoiceLineId: 711, amountCents: 2300, disposition: { kind: "price_reduction", component: "product" } }] },
      } },
    }) }));
    expect(markup).toContain("Create credit CREDIT-009 for $23.00 against invoice #71, dated 2026-10-19.");
    expect(markup).toContain("Recorded supplier document.");
    expect(markup).toContain("Recover saved credit request");
    expect(markup).toContain("This request does not transfer or record cash.");
  });

  it("retains saved invoice applications and blocks recovery for another operator", () => {
    const markup = render(createElement(SupplierCreditRecovery, { commands: commands({
      blocked: true, recoverAllowed: false,
      recovery: { version: 1, userId: "original-operator", key: "credit-render-key", body: {
        command: "apply", creditId: 9, payload: { expectedVersion: version, reason: "Apply the supplier document.",
          allocations: [{ vendorInvoiceId: 72, appliedAmountCents: 2500 }] },
      } },
    }) }));
    expect(markup).toContain('href="/supplier-credits/9"');
    expect(markup).toContain("Invoice #72: $25.00");
    expect(markup).toContain("original operator");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Recover saved credit request<\/button>/);
  });

  it("renders the create workflow while source invoices load", () => {
    const markup = render(createCreditForm());
    expect(markup).toContain("Record supplier credit document");
    expect(markup).toContain("Loading supplier invoices");
    expect(markup).toContain("Create credit draft");
    expect(markup).toContain("does not reduce an invoice balance or record a cash refund");
  });

  it("renders loaded source invoice choices and their pagination", () => {
    const markup = render(createCreditForm(), client => {
      client.setQueryData(invoiceWorkListQuery({
        status: "approved,partially_paid,paid", search: "", offset: 0, limit: 20,
      }).queryKey, invoicePage);
    });
    expect(markup).toContain("INV-071");
    expect(markup).toContain("Original invoice $200.00");
    expect(markup).toContain('aria-label="source invoices pages"');
  });

  it("renders the detail loading state", () => {
    expect(render(createElement(SupplierCreditDetail, { creditId: 9, commands: commands() }))).toContain("Loading supplier credit");
  });

  it("renders unavailable detail as an error with a retry", () => {
    const markup = render(createElement(SupplierCreditDetail, { creditId: 9, commands: commands() }), client => setQueryError(client, detailKey));
    expect(markup).toContain("Supplier credit and its financial history are unavailable.");
    expect(markup).toContain("Retry supplier credit");
    expect(markup).not.toContain("No invoice applications recorded.");
  });

  it("renders a recorded draft with approval still required", () => {
    const draft = credit({ status: "draft", balanceState: "draft", appliedAmountCents: 0, unappliedAmountCents: 0,
      approvedBy: null, approvedAt: null, applications: [], costStatus: "pending", costIssues: [],
      capabilities: { approve: allowed, apply: unavailable, void: allowed, replace: unavailable } });
    const markup = render(createElement(SupplierCreditDetail, { creditId: 9, commands: commands() }), client => {
      client.setQueryData(detailKey, draft);
    });
    expect(markup).toContain("Supplier credit CREDIT-009");
    expect(markup).toContain("Approval is required before this document is available to apply to invoices.");
    expect(markup).toContain("Approve credit");
    expect(markup).toContain("No invoice applications recorded.");
    expect(markup).not.toContain("Apply existing supplier credit");
  });

  it("renders approved credit balances, application history, cost review and eligible invoice choices separately", () => {
    const markup = render(createElement(SupplierCreditDetail, { creditId: 9, commands: commands() }), client => {
      client.setQueryData(detailKey, credit());
      client.setQueryData(invoiceWorkListQuery({ status: "approved,partially_paid", vendorId: "3", search: "", offset: 0, limit: 20 }).queryKey, invoicePage);
    });
    for (const text of ["Credit document", "$100.00", "Applied to invoices", "$25.00", "Available credit", "$75.00",
      "Recorded source cost requires accounting review.", "INV-072", "Reverse application #19", "Apply existing supplier credit"]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('aria-label="credit invoices pages"');
    expect(markup).toContain("Cash paid and original invoice amounts stay separate.");
  });

  it("renders the top-level credit work list while loading", () => {
    expect(render(createElement(SupplierCredits))).toContain("Loading supplier credits");
  });

  it("renders the loaded credit work list and pagination through real providers", () => {
    const markup = render(createElement(SupplierCredits), client => {
      client.setQueryData(listKey, supplierCreditListSchema.parse({
        items: [credit()], total: 1, limit: 20, offset: 0, nextOffset: null,
      }));
    });
    expect(markup).toContain("CREDIT-009");
    expect(markup).toContain('href="/supplier-credits/9?tab=details"');
    expect(markup).toContain("Cost disposition: review required");
    expect(markup).toContain('aria-label="supplier credits pages"');
  });

  it("renders a list read failure without claiming there are no credits", () => {
    const markup = render(createElement(SupplierCredits), client => setQueryError(client, listKey));
    expect(markup).toContain("Supplier credits are unavailable.");
    expect(markup).toContain("Retry supplier credits");
    expect(markup).not.toContain("No supplier credits match these filters.");
  });
});
