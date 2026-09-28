import { sql } from "drizzle-orm";
import { z } from "zod";
import { createExpectedWmsReturn } from "../../wms/expected-return-commands";
import { parseReturnPolicySnapshot } from "../domain/return-case-actions";
import {
  CustomerReturnIntakeError, customerReturnIntakeResultSchema, type CustomerReturnIntakeResult,
  type CustomerReturnIntakeStore, type PreparedCustomerReturnIntake
} from "../application/customer-return-intake.ports";
import { validatePreparedCustomerReturnIntake } from "../application/customer-return-intake.service";
import { portalInventoryReturnMirrorSql } from "./customer-return-inventory-mirror";
import { acquireReturnPolicyCatalogLock } from "./return-policy-lock";
import { readCustomerReturnPolicyCandidates } from "./customer-return-policy.reader";
import { resolveCustomerReturnPortalPolicy } from "../application/customer-return-policy";
import { snapshotReturnPolicy } from "../domain/return-case";
import { customerReturnLabelSettingsSchema } from "@shared/returns/customer-return-label.contract";
import { RETURN_LABEL_CONTROL_LOCK_NAMESPACE } from "./customer-return-label-settings.repository";
import {
  PostgresCustomerReturnAuthorizationTransaction, type CustomerReturnAuthorizationDatabase,
  type CustomerReturnAuthorizationSqlExecutor
} from "./customer-return-authorization.repository";

type Executor = CustomerReturnAuthorizationSqlExecutor;
const integer = z.coerce.number().int().nonnegative().safe();
const positive = integer.refine(value => value > 0);
const MAX_INTAKE_SOURCE_AGE_MS = 120_000;

export class PostgresCustomerReturnIntakeStore implements CustomerReturnIntakeStore {
  constructor(private readonly database: CustomerReturnAuthorizationDatabase, private readonly clock: () => Date = () => new Date()) { }

  find(input: Parameters<CustomerReturnIntakeStore["find"]>[0]): Promise<CustomerReturnIntakeResult | null> {
    return this.database.transaction(tx => findIntake(tx, input));
  }

  async persist(raw: PreparedCustomerReturnIntake & { now: Date }): Promise<CustomerReturnIntakeResult> {
    const input = validatePreparedCustomerReturnIntake(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "now")));
    const requestedAt = z.date().parse(raw.now);
    const age = requestedAt.getTime() - Date.parse(input.observedAt);
    if (!Number.isFinite(age) || age < 0 || age > MAX_INTAKE_SOURCE_AGE_MS) sourceChanged();
    return this.database.transaction(async tx => {
      await acquireReturnPolicyCatalogLock(tx, "shared");
      // Lock the durable submit lease before entitlement. A superseded preparer
      // cannot create a second root after a retry has rejected/replaced its lease.
      const submission = rows(await tx.execute(sql`SELECT status,lease_token,request_hash,oms_order_id,COALESCE(lease_actor,actor) AS actor,lease_until,
        lease_until > ${requestedAt} AS live_lease FROM returns.customer_return_submission_commands
        WHERE channel_id=${input.channelId} AND idempotency_key=${input.idempotencyKey}::uuid FOR UPDATE`))[0];
      const replay = await findIntake(tx, input);
      if (replay) return replay;
      if (!submission || submission.status !== "preparing" || submission.lease_token !== input.submissionLeaseToken
        || submission.live_lease !== true || submission.request_hash !== input.semanticHash || submission.actor !== input.actor
        || (submission.oms_order_id != null && Number(submission.oms_order_id) !== input.omsOrderId)) {
        throw new CustomerReturnIntakeError("RETURN_LABEL_SUBMISSION_LEASE_CHANGED", "This return request is being handled by another attempt. Check its saved status.");
      }
      await verifyConfiguration(tx, input);
      const authorization = new PostgresCustomerReturnAuthorizationTransaction(tx);
      await authorization.lockCommand({ channelId: input.channelId, idempotencyKey: input.idempotencyKey });
      const locked = await authorization.lockSource({
        channelId: input.channelId, omsOrderId: input.omsOrderId,
        omsOrderLineIds: input.lines.map(line => line.omsOrderLineId)
      });
      if (!locked) sourceChanged();
      const actualClaims = locked.lines.flatMap(line => line.wmsItems.map(item => ({
        wmsOrderItemId: item.wmsOrderItemId,
        legacyExpectedQuantity: item.legacyExpectedQuantity, claimedQuantity: item.claimedQuantity
      })));
      if (canonical(actualClaims.sort(byItem)) !== canonical([...input.expectedClaims].sort(byItem))) sourceChanged();
      // Legacy direct inventory returns do not always create expected-return rows.
      // Recheck this separate authority under the order locks before granting units.
      const inventoryHistory = rows(await tx.execute(sql`SELECT 1 FROM inventory.inventory_transactions it
        LEFT JOIN wms.orders wo ON wo.id=it.order_id WHERE it.transaction_type='return'
        AND (wo.oms_fulfillment_order_id=${String(input.omsOrderId)} OR wo.source_table_id=${String(input.omsOrderId)}
          OR EXISTS (SELECT 1 FROM wms.order_items wi JOIN oms.oms_order_lines ol ON ol.id=wi.oms_order_line_id
            WHERE wi.id=it.order_item_id AND ol.order_id=${input.omsOrderId}))
        AND (NOT EXISTS (SELECT 1 FROM wms.order_items wi JOIN oms.oms_order_lines ol ON ol.id=wi.oms_order_line_id
            WHERE wi.id=it.order_item_id AND wi.order_id=it.order_id AND ol.order_id=${input.omsOrderId})
          OR EXISTS (SELECT 1 FROM wms.order_items wi WHERE wi.id=it.order_item_id
            AND wi.oms_order_line_id IN (${sql.join(input.lines.map(line => sql`${line.omsOrderLineId}`), sql`, `)})))
        AND NOT (${sql.raw(portalInventoryReturnMirrorSql)}) LIMIT 1`));
      if (inventoryHistory.length > 0) sourceChanged();
      // Catalog, settings and order locks can all wait. The source TTL, lease,
      // and purchase-based policy deadline must still hold after the final lock.
      const now = z.date().parse(this.clock());
      const currentAge = now.getTime() - Date.parse(input.observedAt);
      if (currentAge < 0 || currentAge > MAX_INTAKE_SOURCE_AGE_MS) sourceChanged();
      if (now.getTime() >= z.coerce.date().parse(submission.lease_until).getTime()) {
        throw new CustomerReturnIntakeError("RETURN_LABEL_SUBMISSION_LEASE_CHANGED", "This return request expired while waiting. Check its saved status before retrying.");
      }
      // Equality remains eligible, matching evaluateCustomerReturnEligibility.
      if (now.getTime() > Date.parse(input.returnWindowEndsAt)) {
        throw new CustomerReturnIntakeError("RETURN_INTAKE_WINDOW_ELAPSED", "The return window ended while this request was waiting. Reload the order.");
      }
      const result = await authorization.persist({
        channelId: input.channelId, omsOrderId: input.omsOrderId,
        idempotencyKey: input.idempotencyKey, semanticHash: input.semanticHash, eligibilityRevision: input.eligibilityRevision,
        actor: input.actor, now, policySnapshot: input.policySnapshot, warehouseSnapshot: input.warehouseSnapshot, lines: input.lines
      });
      await tx.execute(sql`INSERT INTO returns.customer_return_intakes
        (authorization_id,settings_version,policy_id,policy_version,operational_policy_snapshot,created_at)
        VALUES(${result.authorizationId},${input.settingsVersion},${input.operationalPolicy.id},${input.operationalPolicy.version},
          ${JSON.stringify(input.operationalPolicy.snapshot)}::jsonb,${now})`);
      await materializeCases(tx, input, result.authorizationId, now);
      await persistParcels(tx, input, result.authorizationId, now);
      await tx.execute(sql`UPDATE returns.customer_return_submission_commands SET status='accepted',
        authorization_id=${result.authorizationId},updated_at=${now}
        WHERE channel_id=${input.channelId} AND idempotency_key=${input.idempotencyKey}::uuid
          AND status='preparing' AND lease_token=${input.submissionLeaseToken}::uuid`);
      const saved = await readResult(tx, result.authorizationId, false);
      return customerReturnIntakeResultSchema.parse(saved);
    });
  }
}

async function findIntake(tx: Executor, input: Parameters<CustomerReturnIntakeStore["find"]>[0]): Promise<CustomerReturnIntakeResult | null> {
  const row = rows(await tx.execute(sql`SELECT a.id,a.oms_order_id,c.semantic_hash,i.authorization_id AS intake_id
    FROM returns.customer_return_authorization_commands c JOIN returns.customer_return_authorizations a ON a.id=c.authorization_id
    LEFT JOIN returns.customer_return_intakes i ON i.authorization_id=a.id
    WHERE c.channel_id=${input.channelId} AND c.idempotency_key=${input.idempotencyKey}`))[0];
  if (!row) return null;
  if (Number(row.oms_order_id) !== input.omsOrderId || row.semantic_hash !== input.semanticHash || row.intake_id == null) {
    throw new CustomerReturnIntakeError("RETURN_LABEL_COMMAND_CONFLICT", "This request was already used for different return details.");
  }
  return readResult(tx, positive.parse(row.id), true);
}

async function verifyConfiguration(tx: Executor, input: PreparedCustomerReturnIntake): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(${RETURN_LABEL_CONTROL_LOCK_NAMESPACE},${input.channelId})`);
  const control = rows(await tx.execute(sql`SELECT paused FROM returns.customer_return_label_controls WHERE channel_id=${input.channelId} FOR SHARE`))[0];
  if (control?.paused === true) configurationChanged();
  const row = rows(await tx.execute(sql`SELECT configuration FROM returns.return_policy_shipping WHERE policy_id=${input.operationalPolicy.id}`))[0];
  const settings = row?.configuration == null ? null : customerReturnLabelSettingsSchema.parse(row.configuration);
  if (!settings || settings.enabled !== true || settings.policyId !== input.operationalPolicy.id || settings.version !== input.settingsVersion
    || settings.warehouseId !== input.warehouseSnapshot.warehouseId
    || input.warehouseSnapshot.version !== input.settingsVersion
    || input.parcels.some(parcel => (parcel.selectionMode ?? "fixed_service") !== settings.selectionMode
      || parcel.carrierId !== settings.carrierId || parcel.serviceCode !== settings.serviceCode
      || canonical(parcel.destinationAddress) !== canonical(settings.destinationAddress))) configurationChanged();
  const warehouse = rows(await tx.execute(sql`SELECT is_active,country FROM warehouse.warehouses WHERE id=${settings.warehouseId} FOR SHARE`))[0];
  if (!warehouse || warehouse.is_active !== 1 || warehouse.country !== "US") configurationChanged();
  const resolved = resolveCustomerReturnPortalPolicy(await readCustomerReturnPolicyCandidates(tx, input.channelId), input.channelId);
  const policy = resolved.policy;
  if (resolved.policyIssue || !policy || policy.id !== input.operationalPolicy.id
    || policy.version !== input.operationalPolicy.version) configurationChanged();
  const snapshot = parseReturnPolicySnapshot(snapshotReturnPolicy(policy));
  if (canonical(snapshot) !== canonical(input.operationalPolicy.snapshot)
    || input.policySnapshot.version !== snapshot.version
    || input.policySnapshot.returnWindowDays !== snapshot.returnWindowDays) configurationChanged();
}

async function materializeCases(tx: Executor, input: PreparedCustomerReturnIntake, authorizationId: number, now: Date): Promise<void> {
  const source = rows(await tx.execute(sql`SELECT aa.id AS allocation_id,aa.authorization_line_id,aa.wms_order_item_id,aa.quantity,
    al.oms_order_line_id,al.external_line_item_id,wi.order_id,wi.sku,wi.name,wi.paid_price_cents
    FROM returns.customer_return_authorization_allocations aa
    JOIN returns.customer_return_authorization_lines al ON al.id=aa.authorization_line_id
    JOIN wms.order_items wi ON wi.id=aa.wms_order_item_id WHERE aa.authorization_id=${authorizationId}
    ORDER BY wi.order_id,wi.id,aa.id`));
  const partitions = new Map<number, typeof source>();
  for (const row of source) { const key = positive.parse(row.order_id); partitions.set(key, [...(partitions.get(key) ?? []), row]); }
  for (const [wmsOrderId, allocations] of partitions) {
    const grouped = new Map<number, { row: Record<string, unknown>; quantity: number }>();
    for (const row of allocations) {
      const itemId = positive.parse(row.wms_order_item_id);
      const quantity = integer.parse((grouped.get(itemId)?.quantity ?? 0) + positive.parse(row.quantity));
      grouped.set(itemId, { row, quantity });
    }
    const expected = await createExpectedWmsReturn(tx, {
      orderId: wmsOrderId, source: "customer_portal",
      sourceEventKey: `customer-return:${authorizationId}:${wmsOrderId}`, reason: "customer_return", now,
      items: [...grouped].map(([itemId, { row, quantity }]) => ({
        orderItemId: itemId,
        omsOrderLineId: positive.parse(row.oms_order_line_id), externalLineItemId: String(row.external_line_item_id),
        sku: row.sku == null ? null : String(row.sku), expectedQuantity: quantity, restockPolicy: "return"
      }))
    });
    const policy = input.operationalPolicy;
    const inserted = rows(await tx.execute(sql`INSERT INTO returns.return_cases
      (source_provider,source_event_type,source_event_id,business_context,channel_id,oms_order_id,wms_order_id,wms_return_id,
        policy_id,policy_version,policy_snapshot,case_status,approval_status,logistics_status,inspection_status,
        customer_refund_status,vendor_settlement_status,opened_at,created_at,updated_at)
      VALUES('customer_portal','private_customer_return',${`${authorizationId}:${wmsOrderId}`},'retail',${input.channelId},
        ${input.omsOrderId},${wmsOrderId},${expected.returnId},${policy.id},${policy.version},${JSON.stringify(policy.snapshot)}::jsonb,
        'open','approved','awaiting_return',${policy.snapshot.inspectionRequirement === "none" ? "not_required" : "pending"},
        'pending','not_applicable',${now},${now},${now}) RETURNING id`))[0];
    const caseId = positive.parse(inserted?.id);
    await tx.execute(sql`INSERT INTO returns.customer_return_case_links(authorization_id,case_id,wms_order_id,wms_return_id,created_at)
      VALUES(${authorizationId},${caseId},${wmsOrderId},${expected.returnId},${now})`);
    for (const [itemId, { row, quantity }] of grouped) {
      const returnItemId = expected.items.find(item => item.orderItemId === itemId)?.id;
      if (!returnItemId || row.paid_price_cents == null) sourceChanged();
      const price = integer.parse(row.paid_price_cents);
      const total = integer.parse(price * quantity);
      const savedItem = rows(await tx.execute(sql`INSERT INTO returns.return_case_items
        (return_case_id,wms_return_item_id,oms_order_line_id,wms_order_item_id,external_line_item_id,sku,title,quantity,
          unit_paid_price_cents,source_line_total_cents,created_at)
        VALUES(${caseId},${returnItemId},${row.oms_order_line_id},${itemId},${row.external_line_item_id},${row.sku},${row.name},
          ${quantity},${price},${total},${now}) RETURNING id`))[0];
      const caseItemId = positive.parse(savedItem?.id);
      for (const allocation of allocations.filter(candidate => Number(candidate.wms_order_item_id) === itemId)) {
        await tx.execute(sql`INSERT INTO returns.customer_return_allocation_case_items
          (authorization_id,authorization_allocation_id,case_item_id,wms_return_item_id,created_at)
          VALUES(${authorizationId},${allocation.allocation_id},${caseItemId},${returnItemId},${now})`);
      }
    }
    await tx.execute(sql`INSERT INTO returns.return_case_events(return_case_id,event_type,actor,details,occurred_at,created_at)
      VALUES(${caseId},'private_customer_return_created',${input.actor},
        ${JSON.stringify({ authorizationId, wmsOrderId, wmsReturnId: expected.returnId, refundAuthority: "manual_shopify" })}::jsonb,${now},${now})`);
  }
}

async function persistParcels(tx: Executor, input: PreparedCustomerReturnIntake, authorizationId: number, now: Date): Promise<void> {
  for (const parcel of input.parcels) {
    const saved = rows(await tx.execute(sql`INSERT INTO returns.customer_return_parcels
      (authorization_id,parcel_key,dimensions,weight_grams,origin_address,destination_address,selection_mode,carrier_id,service_code,created_at)
      VALUES(${authorizationId},${parcel.parcelKey},${JSON.stringify(parcel.dimensions)}::jsonb,${parcel.weightGrams},
        ${JSON.stringify(parcel.originAddress)}::jsonb,${JSON.stringify(parcel.destinationAddress)}::jsonb,${parcel.selectionMode ?? "fixed_service"},
        ${parcel.carrierId},${parcel.serviceCode},${now}) RETURNING id`))[0];
    for (const item of parcel.items) {
      await tx.execute(sql`INSERT INTO returns.customer_return_parcel_items(parcel_id,authorization_line_id,quantity)
        SELECT ${saved.id},al.id,${item.quantity} FROM returns.customer_return_authorization_lines al
        WHERE al.authorization_id=${authorizationId} AND al.oms_order_line_id=${item.omsOrderLineId}`);
    }
  }
}

async function readResult(tx: Executor, authorizationId: number, replayed: boolean): Promise<CustomerReturnIntakeResult> {
  const root = rows(await tx.execute(sql`SELECT authorization_number FROM returns.customer_return_authorizations WHERE id=${authorizationId}`))[0];
  const cases = rows(await tx.execute(sql`SELECT rc.id,rc.case_number,cl.wms_order_id,cl.wms_return_id
    FROM returns.customer_return_case_links cl JOIN returns.return_cases rc ON rc.id=cl.case_id
    WHERE cl.authorization_id=${authorizationId} ORDER BY cl.wms_order_id`));
  const parcels = rows(await tx.execute(sql`SELECT id,parcel_key,provider_external_shipment_id,dimensions,weight_grams
    FROM returns.customer_return_parcels WHERE authorization_id=${authorizationId} ORDER BY id`));
  return customerReturnIntakeResultSchema.parse({
    authorizationId, authorizationNumber: root?.authorization_number, replayed,
    cases: cases.map(row => ({ caseId: Number(row.id), caseNumber: row.case_number, wmsOrderId: Number(row.wms_order_id), wmsReturnId: Number(row.wms_return_id) })),
    parcels: parcels.map(row => ({
      parcelId: Number(row.id), parcelKey: row.parcel_key, providerExternalShipmentId: row.provider_external_shipment_id,
      dimensions: row.dimensions, weightGrams: Number(row.weight_grams)
    }))
  });
}
function byItem(left: { wmsOrderItemId: number }, right: { wmsOrderItemId: number }): number { return left.wmsOrderItemId - right.wmsOrderItemId; }
function rows(result: unknown): Record<string, unknown>[] {
  const value = Array.isArray(result) ? result : (result as { rows?: unknown })?.rows;
  if (!Array.isArray(value)) throw new Error("Return intake SQL returned invalid rows.");
  return value as Record<string, unknown>[];
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
function sourceChanged(): never { throw new CustomerReturnIntakeError("RETURN_INTAKE_SOURCE_CHANGED", "Available return quantities changed. Review the order again."); }
function configurationChanged(): never { throw new CustomerReturnIntakeError("RETURN_LABEL_SETTINGS_CHANGED", "Return label settings changed. Reload the return before submitting."); }
