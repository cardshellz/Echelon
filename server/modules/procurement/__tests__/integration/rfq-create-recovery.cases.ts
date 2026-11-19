import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import type { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { describe, expect, it } from "vitest";
import { rfqCreateReceiptSchema, type RfqCreatePayload } from "@shared/procurement/rfq-create-command";
import { createDrizzleFinancialCommandRepository } from "../../../../platform/commands/command-results.repository";
import { createRfqCreateCommands, hashRfqCreateIdentity, rfqCreateCommandScope, RFQ_CREATE_COMMAND_PRINCIPAL } from "../../rfq-create.commands";
import { createRfqWorkflowService } from "../../rfq-workflow.service";
import { lockAndLoadActiveRfqAllocations } from "../../purchasing-rfq.service";
import type { createPurchasingService } from "../../purchasing.service";

export function registerRfqCreationRecoveryCases(harness: {
  pool(): pg.Pool; database(): ReturnType<typeof drizzle<typeof schema>>;
  owner(): ReturnType<typeof createPurchasingService>; actorId: string; suffix: string; now: Date;
  auditUpgradePreserved(): boolean;
}) {
  const input: RfqCreatePayload = { requestNote: "Reviewed initial batch", responseDueDate: null,
    lines: [{ recommendationLineId: 3, vendorId: 5, vendorProductId: 302, requestedPieces: 100 }] };
  const key = (name: string) => `rfq-${harness.suffix}-create-${name}`;
  const identity = (name: string, body: unknown = input, actorId = harness.actorId) => ({ ...rfqCreateCommandScope(),
    actorType: "service" as const, actorId: RFQ_CREATE_COMMAND_PRINCIPAL, idempotencyKey: key(name), requestHash: hashRfqCreateIdentity(body, actorId), contractVersion: 1 });
  function execute(name: string, body: unknown = input, actorId = harness.actorId, owner = harness.owner()) {
    return createRfqCreateCommands(owner, createDrizzleFinancialCommandRepository(harness.database())).execute(body, actorId, identity(name, body, actorId));
  }
  async function seedSelection() {
    await harness.pool().query(`
      INSERT INTO catalog.products(id,sku,name) VALUES(102,'CREATE-RFQ','Initial RFQ product');
      INSERT INTO catalog.product_variants(id,product_id,sku,name,units_per_variant,uom_type,is_base_unit) VALUES(202,102,'CREATE-RFQ-C50','Case of 50',50,'case',false);
      INSERT INTO procurement.vendor_products(id,vendor_id,product_id,product_variant_id) VALUES(302,5,102,202);
      INSERT INTO procurement.purchase_recommendation_lines(id,run_id,recommendation_key,product_id,product_variant_id,warehouse_id,sku,product_name,recommended_pieces,preferred_vendor_id,preferred_vendor_product_id,evidence_snapshot)
        OVERRIDING SYSTEM VALUE VALUES(3,1,'create-rfq',102,202,1,'CREATE-RFQ','Initial RFQ product',100,NULL,NULL,'{}');
    `);
  }
  async function counts(name: string) {
    return (await harness.pool().query(`SELECT
      (SELECT count(*)::int FROM procurement.request_for_quotes WHERE idempotency_key=$1) AS rfqs,
      (SELECT count(*)::int FROM procurement.request_for_quote_lines l JOIN procurement.request_for_quotes r ON r.id=l.rfq_id WHERE r.idempotency_key=$1) AS lines,
      (SELECT count(*)::int FROM public.audit_events WHERE action='purchase_rfq.batch_created' AND context->>'idempotencyKey'=$1) AS audits`, [key(name)])).rows[0];
  }
  async function waitRetry(name: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await harness.pool().query("SELECT next_attempt_at<=clock_timestamp() AS ready FROM public.financial_command_results WHERE actor_id=$1 AND idempotency_key=$2", [RFQ_CREATE_COMMAND_PRINCIPAL, key(name)]);
      if (result.rows[0]?.ready === true) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("RFQ retry did not become due");
  }
  describe("initial RFQ creation durable recovery", () => {
    it("adds the audit guard without rewriting historical evidence and protects only its five RFQ actions", async () => {
      expect(harness.auditUpgradePreserved()).toBe(true);
      const actions = ["purchase_rfq.batch_created", "purchase_rfq.allocation_override_approved", "vendor_catalog.rfq_created", "vendor_catalog.rfq_updated", "vendor_catalog.rfq_preferred_demoted"];
      for (const action of actions) {
        const row = (await harness.pool().query("INSERT INTO public.audit_events(level,actor,action,target,changes) VALUES('AUDIT',$1,$2,'rfq:guard','{\"before\":null,\"after\":{\"kept\":true}}') RETURNING id", [`user:${harness.actorId}`, action])).rows[0];
        await expect(harness.pool().query("UPDATE public.audit_events SET action='unrelated.action' WHERE id=$1", [row.id])).rejects.toMatchObject({ code: "23514" });
        await expect(harness.pool().query("UPDATE public.audit_events SET changes='{}' WHERE id=$1", [row.id])).rejects.toMatchObject({ code: "23514" });
        await expect(harness.pool().query("DELETE FROM public.audit_events WHERE id=$1", [row.id])).rejects.toMatchObject({ code: "23514" });
      }
      await expect(harness.pool().query("TRUNCATE public.audit_events")).rejects.toMatchObject({ code: "23514" });
      const unrelated = (await harness.pool().query("INSERT INTO public.audit_events(level,actor,action,target) VALUES('INFO',$1,'unrelated.action','rfq:guard') RETURNING id", [`user:${harness.actorId}`])).rows[0];
      for (const action of actions) await expect(harness.pool().query("UPDATE public.audit_events SET action=$2 WHERE id=$1", [unrelated.id, action])).rejects.toMatchObject({ code: "23514" });
      await harness.pool().query("UPDATE public.audit_events SET context='{\"unrelated\":true}' WHERE id=$1", [unrelated.id]);
      expect((await harness.pool().query("DELETE FROM public.audit_events WHERE id=$1", [unrelated.id])).rowCount).toBe(1);
    });
    it("records original actor, exact request and before/after catalog evidence at one injected time", async () => {
      await seedSelection();
      await harness.pool().query("INSERT INTO procurement.vendors(id,code,name) VALUES(6,'OTHER-CREATE','Competing supplier'); INSERT INTO procurement.vendor_products(id,vendor_id,product_id,product_variant_id,is_preferred) VALUES(303,6,102,202,1)");
      const first = await execute("audit-evidence");
      const audits = (await harness.pool().query("SELECT action,actor,timestamp,changes,context FROM public.audit_events WHERE actor=$1 ORDER BY id", [`user:${harness.actorId}`])).rows;
      expect(audits.map(row => row.action).sort()).toEqual(["purchase_rfq.batch_created", "vendor_catalog.rfq_preferred_demoted", "vendor_catalog.rfq_updated"]);
      expect(audits.every(row => row.actor === `user:${harness.actorId}` && row.timestamp.toISOString() === harness.now.toISOString())).toBe(true);
      expect(audits.find(row => row.action === "vendor_catalog.rfq_updated").changes).toMatchObject({ before: { isPreferred: 0, isActive: 1 }, after: { isPreferred: 1, isActive: 1 } });
      expect(audits.find(row => row.action === "vendor_catalog.rfq_preferred_demoted").changes).toMatchObject({ before: { isPreferred: 1 }, after: { isPreferred: 0 } });
      expect(audits.find(row => row.action === "purchase_rfq.batch_created")).toMatchObject({ changes: { before: null, after: { lineCount: 1, status: "draft", vendorId: 5 } },
        context: { idempotencyKey: key("audit-evidence"), requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), request: { requestNote: input.requestNote, responseDueDate: null,
          lines: [{ recommendationLineId: 3, vendorId: 5, vendorProductId: 302, vendorSku: null, requestedPieces: 100, quantityOverrideReason: null, allocationOverrideApproved: false }] } } });
      const ledger = (await harness.pool().query("SELECT response_body,expires_at FROM public.financial_command_results WHERE idempotency_key=$1", [key("audit-evidence")])).rows[0];
      expect(ledger.response_body).toEqual(first.body);
      expect(rfqCreateReceiptSchema.parse(ledger.response_body).intent.payload).toEqual(input);
      await expect(harness.pool().query("UPDATE public.financial_command_results SET response_body='{}' WHERE idempotency_key=$1", [key("audit-evidence")])).rejects.toMatchObject({ code: "23514" });
      expect(ledger.expires_at).toBeInstanceOf(Date); // Receipt retention is separate from permanent audit protection.
    });
    it("audits new catalog mapping and approved excess with explicit creation before-state", async () => {
      await seedSelection(); await harness.pool().query("DELETE FROM procurement.vendor_products WHERE id=302");
      const body = { ...input, lines: [{ recommendationLineId: 3, vendorId: 5, requestedPieces: 120, quantityOverrideReason: "Reviewed supplier order minimum", allocationOverrideApproved: true }] };
      expect((await execute("new-mapping-override", body)).terminalState).toBe("succeeded");
      const audits = (await harness.pool().query("SELECT action,timestamp,changes FROM public.audit_events WHERE actor=$1 ORDER BY id", [`user:${harness.actorId}`])).rows;
      expect(audits.every(row => row.timestamp.toISOString() === harness.now.toISOString())).toBe(true);
      expect(audits.find(row => row.action === "vendor_catalog.rfq_created").changes).toMatchObject({ before: null, after: { isPreferred: 1, isActive: 1 } });
      expect(audits.find(row => row.action === "purchase_rfq.allocation_override_approved").changes).toMatchObject({ before: null, after: { requestedPieces: 120, excessPieces: 20, approvedBy: harness.actorId, approvedAt: harness.now.toISOString() } });
    });
    it("legacy creation and replay recheck the current Identity grant under the same graph lock", async () => {
      await seedSelection();
      const legacy = { ...input, idempotencyKey: key("legacy-authority") };
      await harness.owner().createRfqBatch(legacy, harness.actorId);
      await harness.pool().query("DELETE FROM identity.auth_role_permissions WHERE permission_id=1");
      await expect(harness.owner().createRfqBatch(legacy, harness.actorId)).rejects.toMatchObject({ statusCode: 403, details: { code: "RFQ_CREATE_AUTHORITY_REQUIRED" } });
      await expect(harness.owner().createRfqBatch({ ...legacy, idempotencyKey: key("legacy-new-authority") }, harness.actorId)).rejects.toMatchObject({ statusCode: 403 });
      expect(await counts("legacy-authority")).toEqual({ rfqs: 1, lines: 1, audits: 1 });
      expect(await counts("legacy-new-authority")).toEqual({ rfqs: 0, lines: 0, audits: 0 });
    });
    it("recovers after the committed reservation consumes demand without creating another RFQ", async () => {
      await seedSelection(); const first = await execute("lost");
      const receipt = rfqCreateReceiptSchema.parse(first.body);
      expect(await counts("lost")).toEqual({ rfqs: 1, lines: 1, audits: 1 });
      const allocations = await harness.database().transaction(tx => lockAndLoadActiveRfqAllocations(tx, [{ id: 3, productId: 102, productVariantId: 202, warehouseId: 1 }]));
      expect([...allocations.values()]).toEqual([100]);
      expect(await execute("lost")).toMatchObject({ replayed: true, body: receipt });
      expect(await counts("lost")).toEqual({ rfqs: 1, lines: 1, audits: 1 });
      expect(await execute("new-unreviewed")).toMatchObject({ terminalState: "rejected", httpStatus: 400 });
    });
    it("returns a durable reviewed-demand rejection and requires a new deliberate key", async () => {
      await seedSelection(); const changed = { ...input, lines: [{ ...input.lines[0], requestedPieces: 99 }] };
      const rejected = await execute("rejected", changed);
      expect(rejected).toMatchObject({ terminalState: "rejected", body: { details: { rfqCommandOutcome: "rejected", actorId: harness.actorId, idempotencyKey: key("rejected") } } });
      expect(await counts("rejected")).toEqual({ rfqs: 0, lines: 0, audits: 0 });
      expect(await execute("rejected", changed)).toMatchObject({ replayed: true, body: rejected.body });
      await expect(execute("rejected")).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
      expect((await execute("fresh-reviewed")).terminalState).toBe("succeeded");
    });
    it("concurrent submissions preserve one batch, reservation and audit", async () => {
      await seedSelection();
      const outcomes = await Promise.allSettled([execute("concurrent"), execute("concurrent")]);
      expect(outcomes.some(outcome => outcome.status === "fulfilled")).toBe(true);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "FINANCIAL_COMMAND_IN_PROGRESS" });
      }
      expect(await execute("concurrent")).toMatchObject({ terminalState: "succeeded", replayed: true });
      expect(await counts("concurrent")).toEqual({ rfqs: 1, lines: 1, audits: 1 });
    });
    it("preserves changed-body and changed-actor key conflicts", async () => {
      await seedSelection(); await execute("scope");
      await expect(execute("scope", { ...input, requestNote: "Changed request" })).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
      await harness.pool().query("INSERT INTO identity.users(id,username,password,role,active) VALUES('rfq-other','rfq-other','fixture-only','picker',1); INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES('rfq-other',1)");
      await expect(execute("scope", input, "rfq-other")).rejects.toMatchObject({ code: "FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REUSED" });
      expect(await counts("scope")).toEqual({ rfqs: 1, lines: 1, audits: 1 });
    });
    it("rechecks revoked and disabled authority before recovery and succeeds after restoration", async () => {
      await seedSelection(); const first = await execute("authority");
      await harness.pool().query("DELETE FROM identity.auth_role_permissions WHERE permission_id=1");
      await expect(execute("authority")).rejects.toMatchObject({ statusCode: 403, details: { code: "RFQ_CREATE_AUTHORITY_REQUIRED" } });
      await harness.pool().query("INSERT INTO identity.auth_role_permissions(role_id,permission_id,constraints) VALUES(1,1,NULL)");
      await harness.pool().query("UPDATE identity.users SET active=0 WHERE id=$1", [harness.actorId]);
      await expect(execute("authority")).rejects.toMatchObject({ statusCode: 403 });
      await harness.pool().query("UPDATE identity.users SET active=1 WHERE id=$1", [harness.actorId]);
      expect(await execute("authority")).toMatchObject({ replayed: true, body: first.body });
    });
    it.each(["audit", "result"])("rolls back RFQ, supplier changes and reservation after %s persistence failure, then retries the same key", async failure => {
      await seedSelection(); const table = failure === "audit" ? "public.audit_events" : "public.financial_command_results";
      await harness.pool().query(`CREATE FUNCTION public.reject_rfq_create_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF ${failure === "audit" ? "NEW.action='purchase_rfq.batch_created'" : "NEW.status='succeeded' AND NEW.command_name='procurement.rfq.create_batch'"} THEN RAISE EXCEPTION 'injected RFQ persistence failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_rfq_create_test BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION public.reject_rfq_create_test()`);
      try {
        await expect(execute(`rollback-${failure}`)).rejects.toThrow();
        expect(await counts(`rollback-${failure}`)).toEqual({ rfqs: 0, lines: 0, audits: 0 });
        expect((await harness.pool().query("SELECT is_preferred FROM procurement.vendor_products WHERE id=302")).rows[0].is_preferred).toBe(0);
      } finally { await harness.pool().query(`DROP TRIGGER reject_rfq_create_test ON ${table}; DROP FUNCTION public.reject_rfq_create_test()`); }
      await waitRetry(`rollback-${failure}`);
      const committed = await execute(`rollback-${failure}`);
      expect(committed.terminalState).toBe("succeeded"); expect(await execute(`rollback-${failure}`)).toMatchObject({ replayed: true, body: committed.body });
      expect(await counts(`rollback-${failure}`)).toEqual({ rfqs: 1, lines: 1, audits: 1 });
    });
    it("adopts the original legacy key after workflow progress without recreating a released reservation", async () => {
      await seedSelection(); const original = await harness.owner().createRfqBatch({ ...input, idempotencyKey: key("legacy") }, harness.actorId);
      const workflow = createRfqWorkflowService(harness.database(), harness.owner());
      const detail = await workflow.getDetail(original.rfqs[0].id);
      await harness.database().transaction(tx => workflow.executeInTransaction(tx, { operation: "release", rfqId: detail.id, body: { expectedVersion: detail.version, reason: "Supplier declined this request" } }, harness.actorId, harness.now, key("release")));
      const recovered = await execute("legacy");
      expect(rfqCreateReceiptSchema.parse(recovered.body).result).toMatchObject({ reused: true, rfqs: [{ id: detail.id, status: "cancelled" }] });
      expect(await counts("legacy")).toEqual({ rfqs: 1, lines: 1, audits: 1 });
      expect(await execute("legacy")).toMatchObject({ replayed: true, body: recovered.body });
    });
    it.each(["different", "missing"])("does not infer the %s creator of a legacy batch", async creator => {
      await seedSelection(); await harness.owner().createRfqBatch({ ...input, idempotencyKey: key("legacy-actor") }, harness.actorId);
      await harness.pool().query("UPDATE procurement.request_for_quotes SET created_by=$2 WHERE idempotency_key=$1", [key("legacy-actor"), creator === "missing" ? null : "another-actor"]);
      await expect(execute("legacy-actor")).rejects.toMatchObject({ statusCode: 409, details: { code: "RFQ_IDEMPOTENCY_ACTOR_CONFLICT" } });
      expect((await harness.pool().query("SELECT status,response_body FROM public.financial_command_results WHERE idempotency_key=$1", [key("legacy-actor")])).rows[0]).toMatchObject({ status: "retryable", response_body: null });
    });
    it("protects original legacy quantities and retains a batch whose original request note cannot be verified", async () => {
      await seedSelection(); const original = await harness.owner().createRfqBatch({ ...input, idempotencyKey: key("legacy-changed") }, harness.actorId);
      await expect(harness.pool().query("UPDATE procurement.request_for_quote_lines SET requested_pieces=99 WHERE rfq_id=$1", [original.rfqs[0].id])).rejects.toMatchObject({ code: "23514" });
      await harness.pool().query("UPDATE procurement.request_for_quotes SET request_note='Later revised note' WHERE id=$1", [original.rfqs[0].id]);
      await expect(execute("legacy-changed")).rejects.toMatchObject({ code: "RFQ_CREATE_RESULT_INVALID" });
      expect((await harness.pool().query("SELECT status,response_body FROM public.financial_command_results WHERE idempotency_key=$1", [key("legacy-changed")])).rows[0]).toMatchObject({ status: "retryable", response_body: null });
      expect(await counts("legacy-changed")).toEqual({ rfqs: 1, lines: 1, audits: 1 });
    });
    it("drops a committed HTTP response then recovers through the real creation endpoint", async () => {
      await seedSelection(); const { registerPurchasingRecommendationRoutes } = await import("../../purchasing-recommendation.routes");
      const app = express(); app.use(express.json()); let drop = true;
      app.use((req, res, next) => { req.session = { user: { id: harness.actorId } } as never;
        const json = res.json.bind(res); res.json = ((body: unknown) => { if (drop && res.statusCode < 300) { drop = false; res.destroy(); return res; } return json(body); }) as typeof res.json; next(); });
      Object.assign(app.locals, { services: { purchasing: harness.owner() } }); registerPurchasingRecommendationRoutes(app);
      const server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/purchasing/rfq-queue`;
        // Node HTTP accepts every ephemeral loopback port; fetch rejects its
        // browser-blocked ports before exercising the actual route.
        const request = (versioned = true) => new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: unknown }>((resolve, reject) => {
          const outgoing = http.request(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key("http"), ...(versioned ? { "X-RFQ-Receipt-Version": "1" } : {}) } }, response => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("aborted", () => reject(new Error("HTTP response was lost")));
            response.once("error", reject);
            response.once("end", () => { try { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch (error) { reject(error); } });
          });
          outgoing.once("error", reject); outgoing.end(JSON.stringify(versioned ? input : { ...input, idempotencyKey: key("http") }));
        });
        await expect(request()).rejects.toThrow();
        const recovered = await request(); expect(recovered.status).toBe(201); expect(recovered.headers["idempotency-replayed"]).toBe("true");
        expect(rfqCreateReceiptSchema.safeParse(recovered.body).success).toBe(true);
        const legacy = await request(false); expect(legacy.status).toBe(200);
        expect(legacy.body).toMatchObject({ reused: true, rfqs: [{ createdBy: harness.actorId }], lines: [{ requestedPieces: 100 }] });
        expect(legacy.body).not.toHaveProperty("intent");
        expect(await counts("http")).toEqual({ rfqs: 1, lines: 1, audits: 1 });
      } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
    });
  });
}
