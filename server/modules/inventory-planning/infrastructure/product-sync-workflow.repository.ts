import type { Pool } from "pg";
import { z } from "zod";
import { inventoryProductSyncReviewSchema } from "@shared/types/inventory-product-sync";
import { productSyncSavedCommandSchema, productSyncLinkScopeSchema, type ProductSyncStart,
  type ProductSyncLinkScope } from "@shared/types/inventory-product-sync-workflow";
import type { ProductSyncJob, ProductSyncJobUpdate, ProductSyncWorkflowStore } from "../application/product-sync-workflow.service";
import { InventoryProductSyncError } from "../application/inventory-product-sync.service";
import { PRODUCT_SYNC_WORKFLOW_LIMITS as L, missingProductSyncLinks, type ProductSyncLinkCheck } from "../domain/product-sync-workflow";
import { executeInventoryPublicationCommand } from "./inventory-publication-command-transaction";
import { captureReview } from "./inventory-product-sync.repository";
import { requestProductStockLinkChecks } from "./stock-link-checks.repository";

const jobSchema = z.object({
  idempotencyKey: z.string().uuid(), productId: z.number().int().positive(), requestedBy: z.string().min(1).max(100),
  requestedAt: z.date(), updatedAt: z.date(), state: z.enum(["checking_links", "publishing", "queued", "blocked", "failed"]),
  message: z.string().min(1), review: inventoryProductSyncReviewSchema, publicationCommand: productSyncSavedCommandSchema,
  deadlineAt: z.date(), attempts: z.number().int().nonnegative(), leaseToken: z.string().uuid().nullable(),
}).superRefine((job, context) => {
  if (job.review.productId !== job.productId || job.state === "publishing" && job.publicationCommand === null
    || job.publicationCommand && (job.publicationCommand.productId !== job.productId || job.publicationCommand.idempotencyKey !== job.idempotencyKey))
    context.addIssue({ code: "custom", message: "The saved publication must belong to this product request." });
});
const columns = `id::text AS "idempotencyKey",product_id AS "productId",requested_by AS "requestedBy",
  requested_at AS "requestedAt",updated_at AS "updatedAt",state,message,review,publication_command AS "publicationCommand",
  deadline_at AS "deadlineAt",attempts,lease_token::text AS "leaseToken"`;
const failure = (code: string, message: string, status = 409) => new InventoryProductSyncError(`PRODUCT_SYNC_${code}`, message, status);

/** Short serializable transactions only; no provider I/O while a row is locked. */
export class PostgresProductSyncWorkflowStore implements ProductSyncWorkflowStore {
  constructor(private readonly pool: Pick<Pool, "query" | "connect">) {}
  accept(command: ProductSyncStart, actor: string, hash: string, now: Date): Promise<ProductSyncJob> {
    return executeInventoryPublicationCommand(this.pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`product-sync-workflow:${command.idempotencyKey}`]);
      const prior = (await client.query(`SELECT ${columns},request_hash FROM inventory.product_inventory_sync_requests WHERE id=$1`,
        [command.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) throw failure("COMMAND_CONFLICT", "This sync request belongs to another product or user.");
        const recorded = jobSchema.parse(prior);
        if (recorded.state !== "failed") return recorded;
        // Explicit recovery retains the original publication body and key. It
        // never starts another desired revision after an uncertain commit.
        const state = recorded.publicationCommand === null ? "checking_links" : "publishing";
        const resumed = await client.query(`UPDATE inventory.product_inventory_sync_requests
          SET state=$2,message='Retrying the original inventory sync.',updated_at=$3,next_attempt_at=$3,deadline_at=$4,
            lease_token=NULL,lease_expires_at=NULL WHERE id=$1 RETURNING ${columns}`,
        [command.idempotencyKey,state,now,new Date(now.getTime()+L.deadlineMs)]);
        await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
          VALUES($1,'AUDIT',$2,'inventory_availability.product_sync.retried',$3,$4::jsonb,$5::jsonb)`,
        [now,actor,`catalog.product:${command.productId}`,JSON.stringify({before:{state:"failed"},after:{state}}),
          JSON.stringify({requestId:command.idempotencyKey,productId:command.productId})]);
        return jobSchema.parse(resumed.rows[0]);
      }
      // Prevent a new workflow from taking over an older, separately recorded v1 command.
      const legacy = await client.query("SELECT 1 FROM public.idempotency_keys WHERE key=$1", [`inventory-product-sync:${command.idempotencyKey}`]);
      if (legacy.rows.length) throw failure("COMMAND_CONFLICT", "This identity already belongs to a recorded inventory publication.");
      const review = await captureReview(client, command.productId);
      if (review.blockers.length) throw failure("BLOCKED", review.blockers.join(" "));
      const message = "Checking this product's inventory links before ATP publication.";
      const result = await client.query(`INSERT INTO inventory.product_inventory_sync_requests
        (id,product_id,requested_by,request_hash,state,message,review,requested_at,updated_at,next_attempt_at,deadline_at)
        VALUES($1,$2,$3,$4,'checking_links',$5,$6::jsonb,$7,$7,$7,$8) RETURNING ${columns}`,
      [command.idempotencyKey,command.productId,actor,hash,message,JSON.stringify(review),now,new Date(now.getTime()+L.deadlineMs)]);
      const scope = missingProductSyncLinks(review);
      // Waking the old draft rejection and accepting the request commit together.
      // A lost acceptance response can only replay this request, never wake twice.
      await requestProductStockLinkChecks(client, scope, now);
      await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
        VALUES($1,'AUDIT',$2,'inventory_availability.product_sync.requested',$3,$4::jsonb,$5::jsonb)`,
      [now,actor,`catalog.product:${command.productId}`,JSON.stringify({before:null,after:{state:"checking_links"}}),
        JSON.stringify({requestId:command.idempotencyKey,requestHash:hash,productId:command.productId,linkScope:scope})]);
      return jobSchema.parse(result.rows[0]);
    });
  }
  async read(key: string, actor: string): Promise<ProductSyncJob> {
    const row = (await this.pool.query(`SELECT ${columns} FROM inventory.product_inventory_sync_requests
      WHERE id=$1 AND requested_by=$2`,[key,actor])).rows[0];
    if (!row) throw failure("NOT_FOUND", "This user's product sync request was not found.",404);
    return jobSchema.parse(row);
  }
  claim(now: Date, leaseToken: string): Promise<ProductSyncJob|null> {
    return executeInventoryPublicationCommand(this.pool, async client => {
      const rows = (await client.query(`WITH due AS (
        SELECT id FROM inventory.product_inventory_sync_requests
        WHERE state IN ('checking_links','publishing') AND next_attempt_at <= $1
          AND (lease_token IS NULL OR lease_expires_at <= $1)
        ORDER BY next_attempt_at,requested_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
        UPDATE inventory.product_inventory_sync_requests SET lease_token=$2,lease_expires_at=$3,attempts=attempts+1
        WHERE id IN (SELECT id FROM due) RETURNING ${columns}`,[now,leaseToken,new Date(now.getTime()+L.leaseMs)])).rows;
      return rows.length ? jobSchema.parse(rows[0]) : null;
    });
  }
  save(job: ProductSyncJob, update: ProductSyncJobUpdate, now: Date, release: boolean): Promise<void> {
    return executeInventoryPublicationCommand(this.pool, async client => {
      const previous = (await client.query(`SELECT state,message FROM inventory.product_inventory_sync_requests
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at>$3 FOR UPDATE`,[job.idempotencyKey,job.leaseToken,now])).rows[0];
      if (!previous) throw failure("LEASE_LOST", "Another worker has resumed this product sync.");
      await client.query(`UPDATE inventory.product_inventory_sync_requests SET state=$4,message=$5,review=$6::jsonb,
        publication_command=$7::jsonb,updated_at=$3,next_attempt_at=$8,
        lease_token=CASE WHEN $9 THEN NULL ELSE lease_token END,
        lease_expires_at=CASE WHEN $9 THEN NULL ELSE lease_expires_at END
        WHERE id=$1 AND lease_token=$2`,[job.idempotencyKey,job.leaseToken,now,update.state,update.message,
        JSON.stringify(update.review),update.publicationCommand === null ? null : JSON.stringify(update.publicationCommand),update.nextAttemptAt,release]);
      if (previous.state !== update.state || previous.message !== update.message)
        await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
          VALUES($1,'AUDIT',$2,'inventory_availability.product_sync.progressed',$3,$4::jsonb,$5::jsonb)`,
        [now,job.requestedBy,`catalog.product:${job.productId}`,JSON.stringify({before:previous,after:{state:update.state,message:update.message}}),
          JSON.stringify({requestId:job.idempotencyKey,productId:job.productId,worker:"product_inventory_sync"})]);
    });
  }
  async readLinkChecks(input: ProductSyncLinkScope, now: Date): Promise<readonly ProductSyncLinkCheck[]> {
    const scope = productSyncLinkScopeSchema.parse(input);
    const pairs = scope.targets.flatMap(target => target.productVariantIds.map(productVariantId =>
      ({publicationTargetId:target.publicationTargetId,productVariantId})));
    if (!pairs.length) return [];
    const rows = (await this.pool.query(`SELECT p."publicationTargetId",p."productVariantId",c.status,
      c.reason_code AS "reasonCode",c.error_class AS "errorClass",c.next_check_at AS "nextCheckAt",c.lease_token::text AS "leaseToken",
      d.paused_until AS "pausedUntil",
      COALESCE(t.state='live' AND t.publication_authority='echelon' AND t.held_at IS NULL
        AND COALESCE(d.auto_link_enabled,true) AND d.halted_at IS NULL,false) AS available
      FROM jsonb_to_recordset($1::jsonb) AS p("publicationTargetId" integer,"productVariantId" integer)
      LEFT JOIN inventory.inventory_publication_targets t ON t.id=p."publicationTargetId"
      LEFT JOIN inventory.stock_link_destinations d ON d.publication_target_id=t.id
      LEFT JOIN inventory.stock_link_checks c ON c.publication_target_id=t.id AND c.product_variant_id=p."productVariantId"`,
    [JSON.stringify(pairs)])).rows;
    return z.array(z.object({publicationTargetId:z.number().int().positive(),productVariantId:z.number().int().positive(),
      status:z.string().nullable(),reasonCode:z.string().nullable(),errorClass:z.string().nullable(),nextCheckAt:z.date().nullable(),
      leaseToken:z.string().nullable(),pausedUntil:z.date().nullable(),available:z.boolean()})).parse(rows);
  }
}
