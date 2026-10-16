import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchAutoDraftPoAgingRows } from "../../auto-draft-po-aging.repository";
import { buildStaleAutoDraftPoDiagnostics } from "../../auto-draft-po-aging.service";
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
  "current financial evidence in complete auto-draft follow-up reads",
  () => {
    const fixture = new PoFinancialRefreshFixture();
    beforeAll(() => fixture.start(url!));
    beforeEach(() => fixture.seed());
    afterAll(() => fixture.stop());

    async function makeHistoricalClosed(ids: number[]) {
      await fixture.pool.query(
        `UPDATE procurement.purchase_orders SET source='auto_draft',status='closed',
      physical_status='received',financial_status='paid',line_count=1,actual_delivery_date='2026-08-01',
      created_at='2026-07-01',updated_at='2026-08-01',fully_paid_at='2026-08-01' WHERE id=ANY($1)`,
        [ids],
      );
    }
    async function settle(invoiceId: number, amount: number) {
      // Approved source state is a fixture prerequisite; the actual payment owner
      // persists and reconciles settlement and its immutable allocation records.
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoices SET status='approved',due_date='2026-12-01' WHERE id=$1",
        [invoiceId],
      );
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

    it("keeps a historical cached-paid PO with no invoice proof actionable without changing history", async () => {
      await makeHistoricalClosed([10]);
      const before = await fixture.snapshot();
      const rows = await fetchAutoDraftPoAgingRows(fixture.db);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: 10,
        financialStatus: "paid",
        financialWorkflow: { state: "unbilled" },
      });
      expect(
        buildStaleAutoDraftPoDiagnostics(rows, { now: asOf }).items[0],
      ).toMatchObject({
        poId: 10,
        stage: "ap_closeout_pending",
        action: { action: "create_invoice" },
      });
      expect(await fixture.snapshot()).toEqual(before);
    });

    it("retains shared partial payment review even when the cached PO status says paid", async () => {
      const invoiceId = await fixture.createInvoice([10, 20]);
      await settle(invoiceId, 1000);
      await makeHistoricalClosed([10, 20]);
      const rows = await fetchAutoDraftPoAgingRows(fixture.db, { pageSize: 1 });
      expect(rows.map((row) => row.financialWorkflow?.state)).toEqual([
        "review_required",
        "review_required",
      ]);
      const diagnostics = buildStaleAutoDraftPoDiagnostics(rows, { now: asOf });
      expect(diagnostics.counts.apCloseoutPending).toBe(2);
      expect(
        diagnostics.items.every(
          (item) => item.action.action === "review_financial_evidence",
        ),
      ).toBe(true);
    });

    it("requires invoice approval and refuses cached zero balance as completion", async () => {
      await fixture.createInvoice([10]);
      await makeHistoricalClosed([10]);
      const rows = await fetchAutoDraftPoAgingRows(fixture.db);
      expect(rows[0].financialWorkflow?.state).toBe("awaiting_approval");
      expect(
        buildStaleAutoDraftPoDiagnostics(rows, { now: asOf }).items[0].action
          .action,
      ).toBe("review_invoice_approval");
    });

    it("excludes only verified settled closed POs and retains any open exception", async () => {
      const invoiceId = await fixture.createInvoice([10]);
      await settle(invoiceId, 1000);
      await makeHistoricalClosed([10]);
      expect(await fetchAutoDraftPoAgingRows(fixture.db)).toEqual([]);
      await fixture.pool
        .query(`INSERT INTO procurement.po_exceptions(po_id,kind,severity,status,title,payload,payload_hash,detected_by)
      VALUES(10,'past_due','warn','open','Retained operator review','{}','operator-review','operator')`);
      const rows = await fetchAutoDraftPoAgingRows(fixture.db);
      expect(rows[0]).toMatchObject({
        id: 10,
        financialWorkflow: { state: "settled" },
        openExceptionCount: 1,
      });
      expect(
        buildStaleAutoDraftPoDiagnostics(rows, { now: asOf }).items[0].action
          .action,
      ).toBe("open_exceptions");
    });

    it("does not hide an inconsistent paid header with missing payment evidence", async () => {
      const invoiceId = await fixture.createInvoice([10]);
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoices SET status='paid',paid_amount_cents=1000,balance_cents=0 WHERE id=$1",
        [invoiceId],
      );
      await makeHistoricalClosed([10]);
      expect(
        (await fetchAutoDraftPoAgingRows(fixture.db))[0].financialWorkflow
          ?.state,
      ).toBe("review_required");
    });

    it("traverses past 501 settled candidates to include an older unresolved PO", async () => {
      await fixture.pool.query(`
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,source,status,physical_status,financial_status,line_count,
        total_cents,actual_delivery_date,created_at,updated_at)
        SELECT i,'SETTLED-'||i,5,'auto_draft','closed','received','paid',1,100,'2026-09-01','2026-08-01','2026-10-14'
        FROM generate_series(100,600) i;
      INSERT INTO procurement.purchase_order_lines(id,purchase_order_id,line_number,order_qty,unit_cost_cents,unit_cost_mills,line_total_cents)
        SELECT 10000+i,i,1,1,100,10000,100 FROM generate_series(100,600) i;
      INSERT INTO procurement.vendor_invoices(id,vendor_id,invoice_number,status,invoiced_amount_cents,paid_amount_cents,balance_cents)
        VALUES(8000,5,'SETTLED-SHARED','paid',50100,50100,0);
      INSERT INTO procurement.vendor_invoice_po_links(vendor_invoice_id,purchase_order_id)
        SELECT 8000,i FROM generate_series(100,600) i;
      INSERT INTO procurement.vendor_invoice_lines(vendor_invoice_id,purchase_order_line_id,line_number,qty_invoiced,unit_cost_cents,unit_cost_mills,line_total_cents)
        SELECT 8000,10000+i,i,1,100,10000,100 FROM generate_series(100,600) i;
      INSERT INTO procurement.ap_payments(id,payment_number,vendor_id,payment_date,payment_method,total_amount_cents,status)
        VALUES(8000,'SETTLED-SHARED-PAYMENT',5,'2026-10-01','wire',50100,'completed');
      INSERT INTO procurement.ap_payment_allocations(ap_payment_id,vendor_invoice_id,applied_amount_cents) VALUES(8000,8000,50100);
      INSERT INTO procurement.purchase_orders(id,po_number,vendor_id,source,status,physical_status,financial_status,line_count,
        actual_delivery_date,created_at,updated_at)
        VALUES(900,'OLDER-UNRESOLVED',5,'auto_draft','closed','received','paid',1,'2026-01-01','2025-12-01','2026-01-01');
    `);
      const rows = await fetchAutoDraftPoAgingRows(fixture.db, {
        pageSize: 100,
      });
      expect(rows.map((row) => row.id)).toEqual([900]);
      expect(
        buildStaleAutoDraftPoDiagnostics(rows, { now: asOf }).counts.critical,
      ).toBe(1);
    });

    it("keeps pages and financial source reads on one snapshot during a concurrent ownership change", async () => {
      await fixture.createInvoice([10, 20]);
      await makeHistoricalClosed([10, 20]);
      const { pool: modulePool } = await import("../../../../db");
      const originalConnect = modulePool.connect;
      const connect = originalConnect as unknown as () => Promise<
        import("pg").PoolClient
      >;
      let changed = false;
      modulePool.connect = (async () => {
        const client = await connect.call(modulePool);
        const originalQuery = client.query,
          originalRelease = client.release;
        client.query = (async (...args: unknown[]) => {
          const first = args[0];
          const text =
            typeof first === "string"
              ? first
              : typeof first === "object" && first !== null && "text" in first
                ? String(first.text)
                : "";
          const result: unknown = await Reflect.apply(
            originalQuery,
            client,
            args,
          );
          if (
            !changed &&
            text.includes("FROM procurement.purchase_orders po")
          ) {
            changed = true;
            await fixture.pool.query(
              "UPDATE procurement.vendor_invoice_lines SET purchase_order_line_id=NULL WHERE purchase_order_line_id=22",
            );
          }
          return result;
        }) as typeof client.query;
        client.release = (error) => {
          client.query = originalQuery;
          client.release = originalRelease;
          originalRelease(error);
        };
        return client;
      }) as typeof modulePool.connect;
      try {
        const rows = await fetchAutoDraftPoAgingRows(fixture.db, {
          pageSize: 1,
        });
        expect(rows.map((row) => row.financialWorkflow?.state)).toEqual([
          "awaiting_approval",
          "awaiting_approval",
        ]);
        expect(changed).toBe(true);
      } finally {
        modulePool.connect = originalConnect;
      }
      expect(
        (await fetchAutoDraftPoAgingRows(fixture.db)).every(
          (row) => row.financialWorkflow?.state === "review_required",
        ),
      ).toBe(true);
    });

    it("keeps cancelled PO debt and open exceptions while excluding proven no-work cancellations", async () => {
      const invoiceId = await fixture.createInvoice([10]);
      await fixture.pool.query(
        "UPDATE procurement.vendor_invoices SET status='approved',due_date='2026-12-01' WHERE id=$1",
        [invoiceId],
      );
      await makeHistoricalClosed([10, 20]);
      await fixture.pool.query(
        "UPDATE procurement.purchase_orders SET status='cancelled',physical_status='cancelled' WHERE id IN(10,20)",
      );
      const rows = await fetchAutoDraftPoAgingRows(fixture.db);
      expect(rows.map((row) => row.id)).toEqual([10]);
      expect(rows[0].financialWorkflow?.state).toBe("payment_due");
      expect(
        buildStaleAutoDraftPoDiagnostics(rows, { now: asOf }).items[0].action
          .action,
      ).toBe("record_payment");
      await settle(invoiceId, 1000);
      expect(await fetchAutoDraftPoAgingRows(fixture.db)).toEqual([]);
      await fixture.pool
        .query(`INSERT INTO procurement.po_exceptions(po_id,kind,severity,status,title,payload,payload_hash,detected_by)
      VALUES(20,'past_due','warn','open','Retained cancellation review','{}','cancelled-review','operator')`);
      expect(
        (await fetchAutoDraftPoAgingRows(fixture.db)).map((row) => row.id),
      ).toEqual([20]);
    });

    it("decodes exact PostgreSQL bigint cents without rounding", async () => {
      await makeHistoricalClosed([10]);
      await fixture.pool.query(
        "UPDATE procurement.purchase_orders SET total_cents=$1 WHERE id=10",
        [String(Number.MAX_SAFE_INTEGER)],
      );
      const rows = await fetchAutoDraftPoAgingRows(fixture.db);
      expect(rows[0].totalCents).toBe(Number.MAX_SAFE_INTEGER);
      await fixture.pool.query(
        "UPDATE procurement.purchase_orders SET total_cents=$1 WHERE id=10",
        [String(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1))],
      );
      const before = await fixture.snapshot();
      await expect(fetchAutoDraftPoAgingRows(fixture.db)).rejects.toThrow();
      expect(await fixture.snapshot()).toEqual(before);
    });

    it.each([0, -1, 1001, 1.5, Number.NaN])(
      "rejects invalid query page size %s before scanning",
      async (pageSize) => {
        await expect(
          fetchAutoDraftPoAgingRows(fixture.db, { pageSize }),
        ).rejects.toThrow();
      },
    );
  },
);
