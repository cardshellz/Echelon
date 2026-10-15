import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPoFinancialExceptionService } from "../../po-financial-exceptions.service";
import {
  PoFinancialRefreshFixture,
  REFRESH_ACTOR,
} from "./po-financial-refresh.fixture";
const url = process.env.ECHELON_TEST_DATABASE_URL;
const databaseTests =
  url && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true"
    ? describe
    : describe.skip;
const asOf = new Date("2026-10-15T12:00:00Z");
databaseTests.sequential(
  "financial alert synchronization with real PostgreSQL evidence",
  () => {
    const fixture = new PoFinancialRefreshFixture();
    let service: ReturnType<typeof createPoFinancialExceptionService>,
      invoiceId: number;
    beforeAll(async () => {
      await fixture.start(url!);
      await fixture.pool.query(
        readFileSync("migrations/0566_po_exceptions.sql", "utf8"),
      );
      service = createPoFinancialExceptionService(fixture.db);
    });
    beforeEach(async () => {
      await fixture.seed();
      invoiceId = await fixture.createInvoice([10, 20]);
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoices SET due_date='2026-10-14',status='approved' WHERE id=$1",
        [invoiceId],
      );
    });
    afterAll(() => fixture.stop());
    const sync = (poId = 10, time = asOf) =>
      service.synchronize(poId, { asOf: time });
    async function alerts(poId = 10) {
      return (
        await fixture.pool.query(
          "SELECT * FROM procurement.po_exceptions WHERE po_id=$1 AND kind IN ('past_due','overpaid') ORDER BY id",
          [poId],
        )
      ).rows;
    }
    async function pay(amount: number) {
      return fixture.service.recordPayment({
        vendorId: 5,
        paymentDate: asOf,
        paymentMethod: "wire",
        currency: "USD",
        totalAmountCents: amount,
        allocations: [
          { vendorInvoiceId: invoiceId, appliedAmountCents: amount },
        ],
        createdBy: REFRESH_ACTOR,
      });
    }
    async function active() {
      return (await alerts()).filter((row) =>
        ["open", "acknowledged"].includes(row.status),
      );
    }
    it("uses recorded due date regardless of old PO first invoice stamp or changed vendor terms", async () => {
      await fixture.pool.query(
        "UPDATE procurement.purchase_orders SET first_invoiced_at='2000-01-01',outstanding_cents=999999",
      );
      await fixture.pool.query(
        "UPDATE procurement.vendors SET payment_terms_days=0",
      );
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoices SET due_date='2026-11-01' WHERE id=$1",
        [invoiceId],
      );
      await sync();
      expect(await alerts()).toEqual([]);
      await fixture.pool.query(
        "UPDATE procurement.purchase_orders SET first_invoiced_at='2026-10-15'",
      );
      await fixture.pool.query(
        "UPDATE procurement.vendors SET payment_terms_days=999",
      );
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoices SET due_date='2026-10-14' WHERE id=$1",
        [invoiceId],
      );
      await sync();
      expect(await active()).toEqual([
        expect.objectContaining({
          title: "Linked invoice past due",
          payload: expect.objectContaining({
            scope: "linked_invoice",
            outstandingCents: 3000,
          }),
        }),
      ]);
    });
    it("keeps one unchanged active alert and audit across repeated days and concurrent calls", async () => {
      await sync();
      const before = await fixture.snapshot();
      await Promise.all([sync(), sync(10, new Date("2026-10-16T12:00:00Z"))]);
      expect(await fixture.snapshot()).toEqual(before);
    });
    it("replaces changed debt with audited history then retires fully paid invoice alerts", async () => {
      await sync();
      const first = (await active())[0];
      await pay(1000);
      expect(await active()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            outstandingCents: 2000,
            scope: "linked_invoice",
          }),
        }),
      ]);
      expect((await alerts()).find((row) => row.id === first.id)).toMatchObject(
        { status: "resolved", resolved_by: "system:financial-evidence" },
      );
      await pay(2000);
      expect(await active()).toEqual([]);
      const finalAudit = await fixture.pool.query(
        "SELECT changes,context FROM public.audit_events WHERE action='po_financial_exception.synchronized' AND context->>'purchaseOrderId'='10' ORDER BY id DESC LIMIT 1",
      );
      expect(finalAudit.rows[0]).toMatchObject({
        changes: { before: { status: "open" }, after: { status: "resolved" } },
        context: {
          evidence: {
            invoiceIds: [invoiceId],
            invoiceEvidence: [
              expect.objectContaining({
                invoiceId,
                status: "paid",
                paidCents: 3000,
                outstandingCents: 0,
              }),
            ],
          },
        },
      });
      expect(
        (
          await fixture.pool.query(
            "SELECT changes FROM public.audit_events WHERE action='po_financial_exception.synchronized'",
          )
        ).rows.length,
      ).toBeGreaterThan(2);
    });
    it.each(["resolved", "dismissed"] as const)(
      "preserves manual %s history; unchanged source is suppressed and changed source creates a new row",
      async (status) => {
        await sync();
        const first = (await active())[0];
        const lifecycle = await import("../../po-exceptions.service");
        if (status === "resolved")
          await lifecycle.resolveException(
            first.id,
            REFRESH_ACTOR,
            "Reviewed invoice follow-up",
          );
        else
          await lifecycle.dismissException(
            first.id,
            REFRESH_ACTOR,
            "Reviewed invoice follow-up",
          );
        const terminal = (await alerts())[0];
        await sync();
        expect(await alerts()).toEqual([terminal]);
        await pay(1000);
        expect((await alerts())[0]).toEqual(terminal);
        expect(await active()).toHaveLength(1);
      },
    );
    it("never retires manually created financial alerts", async () => {
      const lifecycle = await import("../../po-exceptions.service");
      const manual = await lifecycle.upsertException({
        poId: 10,
        kind: "past_due",
        severity: "warn",
        title: "Operator follow-up",
        detectedBy: "user:reviewer",
        payload: { invoiceId },
      });
      await sync();
      await pay(3000);
      expect(
        (await alerts()).find((row) => Number(row.id) === manual.id),
      ).toMatchObject({ status: "open", title: "Operator follow-up" });
    });
    it("retires an owned alert on canonical unlink without claiming payment", async () => {
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoices SET status='received' WHERE id=$1",
        [invoiceId],
      );
      await sync();
      await fixture.service.unlinkPoFromInvoice(invoiceId, 10, REFRESH_ACTOR);
      expect(await active()).toEqual([]);
      expect((await alerts())[0].resolution_note).toContain(
        "does not assert that its debt was paid",
      );
    });
    it("retires an unpaid canonical non-product void while retaining its historical balance", async () => {
      await sync();
      await fixture.pool.query(
        "UPDATE procurement.purchase_order_lines SET line_type='fee'",
      );
      await fixture.service.voidInvoice(
        invoiceId,
        "Synthetic void",
        REFRESH_ACTOR,
      );
      expect(await active()).toEqual([]);
      expect(
        (
          await fixture.pool.query(
            "SELECT balance_cents FROM procurement.vendor_invoices WHERE id=$1",
            [invoiceId],
          )
        ).rows[0].balance_cents,
      ).toBe("3000");
    });
    it.each(["short_closed", "cancelled"])(
      "still reports actual linked invoice debt on physical %s PO",
      async (physical) => {
        await fixture.pool.query(
          "UPDATE procurement.purchase_orders SET physical_status=$1 WHERE id=10",
          [physical],
        );
        await sync();
        expect(await active()).toHaveLength(1);
      },
    );
    it.each(["due", "settlement", "ownership", "missing_link"])(
      "preserves alerts unchanged for unknown %s evidence",
      async (issue) => {
        await sync();
        const before = await alerts();
        if (issue === "due")
          await fixture.pool.query(
            "UPDATE procurement.vendor_invoices SET due_date=NULL WHERE id=$1",
            [invoiceId],
          );
        if (issue === "settlement")
          await fixture.pool.query(
            "UPDATE procurement.vendor_invoices SET paid_amount_cents=100,balance_cents=2900 WHERE id=$1",
            [invoiceId],
          );
        if (issue === "ownership")
          await fixture.pool.query(
            "UPDATE procurement.vendor_invoice_lines SET purchase_order_line_id=NULL WHERE purchase_order_line_id=21",
          );
        if (issue === "missing_link")
          await fixture.pool.query(
            "DELETE FROM procurement.vendor_invoice_po_links WHERE purchase_order_id=10",
          );
        await sync();
        expect(await alerts()).toEqual(before);
      },
    );
    it("preserves old alerts when an orphan PO line points to a missing invoice header", async () => {
      await sync();
      const before = await alerts();
      // Broken legacy evidence is injected explicitly by dropping only fixture FKs.
      const fks = await fixture.pool.query(
        "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype='f' AND conrelid='procurement.vendor_invoice_lines'::regclass AND confrelid='procurement.vendor_invoices'::regclass",
      );
      for (const row of fks.rows)
        await fixture.pool.query(
          `ALTER TABLE procurement.vendor_invoice_lines DROP CONSTRAINT "${row.conname.replaceAll('"', '""')}"`,
        );
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoice_lines SET vendor_invoice_id=999999 WHERE purchase_order_line_id=21",
      );
      await fixture.pool.query(
        "DELETE FROM procurement.vendor_invoice_po_links WHERE purchase_order_id=10",
      );
      await sync();
      expect(await alerts()).toEqual(before);
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoice_lines SET vendor_invoice_id=$1 WHERE purchase_order_line_id=21",
        [invoiceId],
      );
      for (const row of fks.rows)
        await fixture.pool.query(
          `ALTER TABLE procurement.vendor_invoice_lines ADD CONSTRAINT "${row.conname.replaceAll('"', '""')}" ${row.definition}`,
        );
    });
    it("proves a legacy excess payment from actual allocations, ignoring cached PO totals", async () => {
      await fixture.pool.query(
        "UPDATE procurement.purchase_orders SET paid_total_cents=999999,invoiced_total_cents=1",
      );
      await sync();
      expect((await active()).every((row) => row.kind !== "overpaid")).toBe(
        true,
      );
      // The canonical payment owner rejects over-allocation. Seed only legacy
      // evidence here to verify detection, not a supported payment command.
      await fixture.pool.query(
        "INSERT INTO procurement.ap_payments(id,payment_number,vendor_id,payment_date,payment_method,currency,total_amount_cents,status) VALUES(50,'LEGACY-EXCESS',5,'2026-10-15','wire','USD',3100,'completed')",
      );
      await fixture.pool.query(
        "INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES(50,$1,3100)",
        [invoiceId],
      );
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoices SET status='paid',paid_amount_cents=3100,balance_cents=0 WHERE id=$1",
        [invoiceId],
      );
      await sync();
      expect(await active()).toEqual([
        expect.objectContaining({
          kind: "overpaid",
          payload: expect.objectContaining({
            overageCents: 100,
            scope: "linked_invoice",
          }),
        }),
      ]);
    });
    it("retires a known legacy aggregate alert only after complete current proof", async () => {
      const lifecycle = await import("../../po-exceptions.service");
      const legacy = await lifecycle.upsertException({
        poId: 10,
        kind: "past_due",
        severity: "warn",
        title: "Invoice past due",
        detectedBy: "system",
        payload: { outstandingCents: 9999, termsDays: 30, daysOverdue: 12 },
      });
      await sync();
      expect(
        (await alerts()).find((row) => Number(row.id) === legacy.id),
      ).toMatchObject({
        status: "resolved",
        resolution_note: expect.stringContaining("Legacy PO aggregate"),
      });
      expect(await active()).toHaveLength(1);
    });
    it("rolls back alert retirement, replacement and history when final audit insert fails", async () => {
      await sync();
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoices SET due_date='2026-10-13' WHERE id=$1",
        [invoiceId],
      );
      await fixture.pool
        .query(`CREATE OR REPLACE FUNCTION procurement.reject_refresh_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='po_financial_exception.synchronized' AND NEW.changes->'before'='null'::jsonb THEN RAISE EXCEPTION 'injected financial alert audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_refresh_audit BEFORE INSERT ON public.audit_events FOR EACH ROW EXECUTE FUNCTION procurement.reject_refresh_audit()`);
      const before = await fixture.snapshot();
      await expect(sync()).rejects.toMatchObject({ code: "P0001" });
      expect(await fixture.snapshot()).toEqual(before);
    });
    it("serializes overlapping sync and real payment on the canonical graph lock", async () => {
      await sync();
      const blocker = await fixture.pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'),hashtext('version_1'))",
      );
      const synchronization = sync(),
        payment = pay(3000);
      try {
        expect(await fixture.waitForBlockedGraphWriters(2)).toBe(true);
      } finally {
        await blocker.query("COMMIT");
        blocker.release();
      }
      await Promise.all([synchronization, payment]);
      expect(await active()).toEqual([]);
    });
    it("serializes manual resolution against synchronization without reopening manual history", async () => {
      await sync();
      const first = (await active())[0],
        lifecycle = await import("../../po-exceptions.service");
      const blocker = await fixture.pool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT pg_advisory_xact_lock(hashtext('inventory.cost_graph'),hashtext('version_1'))",
      );
      const synchronize = sync(),
        resolve = lifecycle.resolveException(
          first.id,
          REFRESH_ACTOR,
          "Reviewed concurrently",
        );
      try {
        expect(await fixture.waitForBlockedGraphWriters(2)).toBe(true);
      } finally {
        await blocker.query("COMMIT");
        blocker.release();
      }
      await Promise.all([synchronize, resolve]);
      await sync();
      expect(await alerts()).toEqual([
        expect.objectContaining({
          id: first.id,
          status: "resolved",
          resolved_by: REFRESH_ACTOR,
        }),
      ]);
    });

    it("normalizes repeated requested detector kinds before writing", async () => {
      await service.synchronize(10, { asOf, kinds: ["past_due", "past_due"] });
      expect(await active()).toHaveLength(1);
    });
  },
);
