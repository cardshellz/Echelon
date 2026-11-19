import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import express, { type Request } from "express";
import { describe, expect, it } from "vitest";
import * as schema from "@shared/schema";
import { receivingEntryCommandResultSchema } from "@shared/procurement/receiving-entry-command";
import type { QuantityLedgerTestContext } from "../../../inventory/__tests__/fixtures/quantity-ledger-database";
import { RECEIVING_ENTRY_COMMAND_PRINCIPAL } from "../../receiving-entry.commands";
import type { ReceivingService } from "../../receiving.service";
import { fixtureForeignKeys, fixtureTable } from "./shipment-line-fixture";

interface HttpResult { status: number; body: unknown; replayed: string | undefined }
interface HttpClient {
  post(path: string, key: string, payload: unknown, actorId?: string | null): Promise<HttpResult>;
  loseResponse(path: string, key: string, payload: unknown): Promise<void>;
}

/** The parent redirects server/db to its disposable database. HTTP routes,
 * Identity queries, the default command repository and receiving/inventory SQL
 * owners are real. Session transport is synthetic; the parent retains its
 * channel-sync no-op and limited receipt-cost ports/schema. This is not an
 * acceptance test of external channel delivery or full cost posting. */
export function registerReceivingEntryHttpRecoveryCases(harness: {
  context(): QuantityLedgerTestContext; service(): ReceivingService; actorId: string;
}): void {
  const pool = () => harness.context().pool;

  async function withHttp(run: (client: HttpClient) => Promise<void>): Promise<void> {
    await pool().query(readFileSync(resolve(process.cwd(), "migrations/0085_idempotency_keys.sql"), "utf8"));
    const notificationTables = [schema.notificationTypes, schema.notificationPreferences, schema.notifications] as const;
    for (const table of notificationTables) await pool().query(fixtureTable(table));
    for (const statement of fixtureForeignKeys(notificationTables)) await pool().query(statement);
    // Exercise the real close notification lookup with no subscribers. No
    // messages or WebSocket deliveries leave this disposable fixture.
    await pool().query("INSERT INTO public.notification_types(key,label,category) VALUES('po_received','Receiving complete','receiving')");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const actorId = req.header("X-Test-Actor");
      req.session = { user: actorId ? { id: actorId, role: "admin" } : undefined } as Request["session"];
      next();
    });
    // These paths require receiving only; the full application's unrelated
    // service registry and optional replenishment callback are not installed.
    const services = { receiving: harness.service() } satisfies Pick<typeof app.locals.services, "receiving">;
    app.locals.services = services as typeof app.locals.services;
    const { registerReceivingRoutes } = await import("../../receiving.routes");
    registerReceivingRoutes(app);
    const server = createServer(app);
    await new Promise<void>((resolveStarted, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolveStarted(); });
    });
    const port = (server.address() as AddressInfo).port;

    function send(path: string, key: string, payload: unknown, actorId: string | null, dropResponse: boolean): Promise<HttpResult | null> {
      return new Promise((resolveResult, reject) => {
        let intentionallyDropped = false;
        const body = JSON.stringify(payload);
        const outgoing = request({ host: "127.0.0.1", port, path, method: "POST", headers: {
          "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Idempotency-Key": key,
          ...(actorId ? { "X-Test-Actor": actorId } : {}),
        } }, incoming => {
          if (dropResponse) {
            // Receiving sends headers only after its transaction commits. Tear
            // down the client stream without reading the result body.
            intentionallyDropped = true;
            incoming.destroy();
            outgoing.destroy();
            resolveResult(null);
            return;
          }
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("error", reject);
          incoming.on("end", () => {
            try {
              const replayed = incoming.headers["idempotency-replayed"];
              resolveResult({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                replayed: typeof replayed === "string" ? replayed : undefined });
            } catch (error) { reject(error); }
          });
        });
        outgoing.setTimeout(10_000, () => outgoing.destroy(new Error("Receiving HTTP test request timed out")));
        outgoing.on("error", error => { if (!intentionallyDropped) reject(error); });
        outgoing.end(body);
      });
    }
    try {
      await run({
        async post(path, key, payload, actorId = harness.actorId) {
          const result = await send(path, key, payload, actorId, false);
          if (!result) throw new Error("Expected a receiving HTTP response");
          return result;
        },
        async loseResponse(path, key, payload) {
          expect(await send(path, key, payload, harness.actorId, true)).toBeNull();
        },
      });
    } finally {
      await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()));
    }
  }

  async function savedResult(key: string): Promise<unknown> {
    const rows = (await pool().query(`SELECT status,response_body FROM public.financial_command_results
      WHERE actor_id=$1 AND idempotency_key=$2`, [RECEIVING_ENTRY_COMMAND_PRINCIPAL, key])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("succeeded");
    return rows[0].response_body;
  }

  describe("receiving entry HTTP recovery with the real command ledger", () => {
    it("recovers lost manual-create transport and rechecks current Identity permission before replay", async () => {
      await withHttp(async client => {
        const key = "receiving-http:lost-create";
        const payload = { sourceType: "blind", warehouseId: 1, notes: "HTTP reviewed manual receipt" };
        await client.loseResponse("/api/receiving", key, payload);
        const saved = await savedResult(key);
        const result = receivingEntryCommandResultSchema.parse(saved);
        expect(result.entryCommand).toMatchObject({ action: "create", actorId: harness.actorId, idempotencyKey: key,
          targetId: null, receivingOrderId: result.id, receivingLineId: null });
        expect(await client.post("/api/receiving", key, payload)).toEqual({ status: 201, body: saved, replayed: "true" });
        expect((await pool().query("SELECT count(*)::int AS count FROM procurement.receiving_orders WHERE created_by=$1", [harness.actorId])).rows[0].count).toBe(1);
        expect((await pool().query("SELECT count(*)::int AS count FROM public.audit_events WHERE action='procurement.receiving.entry.create'")).rows[0].count).toBe(1);

        expect((await client.post("/api/receiving", key, payload, null)).status).toBe(401);
        await pool().query("DELETE FROM identity.auth_role_permissions WHERE role_id=1 AND permission_id=1");
        // The session still says admin; actual database authority must prevail.
        expect(await client.post("/api/receiving", key, payload)).toMatchObject({ status: 403,
          body: { error: "Permission denied: inventory:adjust" } });
        expect(await savedResult(key)).toEqual(saved);
        await pool().query("INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES(1,1)");
        expect(await client.post("/api/receiving", key, payload)).toEqual({ status: 201, body: saved, replayed: "true" });
        expect((await pool().query("SELECT count(*)::int AS count FROM public.financial_command_results WHERE actor_id=$1", [RECEIVING_ENTRY_COMMAND_PRINCIPAL])).rows[0].count).toBe(1);
      });
    });

    it("recovers lost Add Line transport, closes one 25-piece batch over HTTP, then replays without more stock", async () => {
      await pool().query("DELETE FROM procurement.receiving_lines WHERE receiving_order_id=50");
      await withHttp(async client => {
        const key = "receiving-http:lost-line";
        const payload = { sku: "P5", productName: "Synthetic five-piece case", productId: 20, productVariantId: 101,
          expectedUnitsPerVariant: 5, expectedQty: 5, receivedQty: 5, putawayLocationId: 100, unitCost: 2, unitCostMills: 200 };
        await client.loseResponse("/api/receiving/50/lines", key, payload);
        const saved = await savedResult(key);
        const result = receivingEntryCommandResultSchema.parse(saved);
        expect(result.lines).toHaveLength(1);
        expect(result.lines?.[0]).toMatchObject({ id: result.entryCommand.receivingLineId, receivedQty: 5, unitsPerVariantSnapshot: 5 });
        expect(await client.post("/api/receiving/50/lines", key, payload)).toEqual({ status: 201, body: saved, replayed: "true" });
        expect((await client.post("/api/receiving/50/close", "receiving-http:close-once", {})).status).toBe(200);
        async function stockState() {
          return (await pool().query(`SELECT
            (SELECT status FROM procurement.receiving_orders WHERE id=50) AS status,
            (SELECT count(*)::int FROM procurement.receiving_lines WHERE receiving_order_id=50) AS lines,
            (SELECT sum(received_qty * units_per_variant_snapshot)::int FROM procurement.receiving_lines WHERE receiving_order_id=50) AS pieces,
            (SELECT count(*)::int FROM inventory.inventory_transactions WHERE receiving_order_id=50 AND transaction_type='receipt') AS stock_receipts,
            (SELECT variant_qty FROM inventory.inventory_levels WHERE product_variant_id=101 AND warehouse_location_id=100) AS on_hand,
            (SELECT count(*)::int FROM public.audit_events WHERE action='procurement.receiving.entry.add-line') AS entry_audits`)).rows[0];
        }
        const closed = await stockState();
        expect(closed).toEqual({ status: "closed", lines: 1, pieces: 25, stock_receipts: 1, on_hand: 25, entry_audits: 1 });
        expect(await client.post("/api/receiving/50/lines", key, payload)).toEqual({ status: 201, body: saved, replayed: "true" });
        expect((await client.post("/api/receiving/50/close", "receiving-http:close-again", {})).status).toBe(200);
        expect(await stockState()).toEqual(closed);
        expect(await savedResult(key)).toEqual(saved);
        expect((await pool().query("SELECT count(*)::int AS count FROM public.notifications")).rows[0].count).toBe(0);
      });
    });
  });
}
