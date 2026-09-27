import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import type { PreparedCustomerReturnIntake } from "../../application/customer-return-intake.ports";
import { createInspectionTestSchema, seedInspectionTestSchema } from "./customer-return-inspection-database";

export const INTAKE_NOW = new Date("2026-09-26T12:00:00.000Z");
export const INTAKE_KEY = "00000000-0000-4000-8000-000000000001";
export const INTAKE_LEASE = "00000000-0000-4000-8000-000000000002";
export const INTAKE_ADDRESS = { name: "Returns test warehouse", addressLine1: "100 Test Way", city: "Test City", state: "PA", postalCode: "19000", countryCode: "US" as const };
export const INTAKE_POLICY = {
  id: 1, name: "Test portal policy", version: 1, scopeKind: "business_context", scopeKey: "context:retail",
  returnWindowDays: 365, returnDestination: "card_shellz", approvalAuthority: "card_shellz", labelProvider: "shipstation",
  returnShippingPayer: "card_shellz", inspectionRequirement: "required", inspectionOwner: "card_shellz",
  customerRefundAuthority: "card_shellz", vendorSettlementTrigger: "none", returnlessRefundAllowed: false
};

export async function createIntakeTestSchema(pool: Pool, options: { carrierSelection?: boolean } = {}): Promise<void> {
  await createInspectionTestSchema(pool);
  await pool.query(readFileSync("migrations/059_wms_order_items_prices.sql", "utf8"));
  await pool.query(readFileSync("migrations/251_customer_return_label_settings.sql", "utf8"));
  if (options.carrierSelection !== false) {
    await pool.query(readFileSync("migrations/252_customer_return_carrier_selection.sql", "utf8"));
  }
}
export async function seedIntakeTestSchema(pool: Pool): Promise<void> {
  await seedInspectionTestSchema(pool);
  await pool.query(`TRUNCATE warehouse.warehouses RESTART IDENTITY CASCADE;
    INSERT INTO warehouse.warehouses(id,code,name,address,city,state,postal_code,country,is_active) OVERRIDING SYSTEM VALUE
      VALUES(1,'TEST','Test warehouse','100 Test Way','Test City','PA','19000','US',1);
    INSERT INTO returns.return_policies(id,name,scope_kind,scope_key,business_context,version,status,return_window_days,
      return_destination,approval_authority,label_provider,return_shipping_payer,inspection_requirement,inspection_owner,
      customer_refund_authority,vendor_settlement_trigger,returnless_refund_allowed,created_by) OVERRIDING SYSTEM VALUE
      VALUES(1,'Test portal policy','business_context','context:retail','retail',1,'active',365,'card_shellz','card_shellz',
        'shipstation','card_shellz','required','card_shellz','card_shellz','none',false,'test');
    UPDATE wms.order_items SET paid_price_cents=125;`);
  await pool.query(`INSERT INTO returns.customer_return_settings(channel_id,version,enabled,warehouse_id,policy_id,carrier_id,service_code,
    destination_address,contact_name,contact_phone,updated_by,updated_at) VALUES(36,1,true,1,1,'se-123','usps_ground_advantage',$1,'Returns test warehouse',NULL,'admin:test',$2)`,
    [JSON.stringify(INTAKE_ADDRESS), INTAKE_NOW]);
  await seedIntakeSubmission(pool);
}
export async function seedIntakeSubmission(pool: Pool, key = INTAKE_KEY, lease = INTAKE_LEASE, hash = "a".repeat(64)): Promise<void> {
  const request = {
    channelId: 36, orderReference: "#TEST-1", sourceRevision: "b".repeat(64), settingsVersion: 1, idempotencyKey: key,
    selections: [{ lineId: "line-101", quantity: 3, reasonCode: null }, { lineId: "line-102", quantity: 1, reasonCode: null }],
    parcels: [{
      dimensions: { lengthMm: 100, widthMm: 100, heightMm: 100 }, originalBoxId: null,
      items: [{ lineId: "line-101", quantity: 3 }, { lineId: "line-102", quantity: 1 }]
    }]
  };
  await pool.query(`INSERT INTO returns.customer_return_submission_commands(channel_id,idempotency_key,request_hash,request_snapshot,status,actor,
    lease_token,lease_until,created_at,updated_at) VALUES(36,$1,$2,$3,'preparing','admin:test',$4,$5,$6,$6)`,
    [key, hash, JSON.stringify(request), lease, new Date(INTAKE_NOW.getTime() + 120_000), INTAKE_NOW]);
}

/** A complete historical fixed-service graph using only columns available in
 * 250/251. Its constraints remain enabled; 252 is applied only after commit. */
export async function seedPreCarrierSelectionIntake(pool: Pool): Promise<void> {
  const prepared = preparedIntake();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO returns.customer_return_authorizations
      (id,authorization_number,channel_id,oms_order_id,eligibility_revision,policy_snapshot,warehouse_snapshot,actor,created_at)
      OVERRIDING SYSTEM VALUE VALUES(1,'RMA-LEGACY',36,100,$1,$2,$3,'admin:test',$4)`,
      [prepared.eligibilityRevision, JSON.stringify(prepared.policySnapshot), JSON.stringify(prepared.warehouseSnapshot), INTAKE_NOW]);
    await client.query(`INSERT INTO returns.customer_return_authorization_lines
      (id,authorization_id,oms_order_line_id,external_line_item_id,quantity,reason_code,created_at)
      OVERRIDING SYSTEM VALUE VALUES(1,1,101,'500',1,NULL,$1)`, [INTAKE_NOW]);
    await client.query(`INSERT INTO returns.customer_return_authorization_allocations
      (id,authorization_id,authorization_line_id,wms_order_item_id,fulfillment_id,fulfillment_line_item_id,quantity,eligible_quantity,delivery_evidence,created_at)
      OVERRIDING SYSTEM VALUE VALUES(1,1,1,301,'gid://shopify/Fulfillment/700','gid://shopify/FulfillmentLineItem/700',1,2,$1,$2)`,
      [JSON.stringify({ source: "shopify", status: "delivered", wmsOriginalQuantity: 2 }), INTAKE_NOW]);
    await client.query(`INSERT INTO returns.customer_return_authorization_commands
      (channel_id,idempotency_key,semantic_hash,authorization_id,response,actor,created_at)
      VALUES(36,$1,$2,1,$3,'admin:test',$4)`, [INTAKE_KEY, prepared.semanticHash,
        JSON.stringify({ authorizationId: 1, authorizationNumber: "RMA-LEGACY", replayed: false }), INTAKE_NOW]);
    await client.query(`INSERT INTO returns.customer_return_authorization_events
      (authorization_id,event_type,actor,details,occurred_at) VALUES(1,'customer_return_authorized','admin:test','{}',$1)`, [INTAKE_NOW]);
    await client.query(`INSERT INTO returns.customer_return_authorization_outbox
      (authorization_id,topic,payload,occurred_at) VALUES(1,'customer_return_authorization.created','{"authorizationId":1,"channelId":36}',$1)`, [INTAKE_NOW]);
    await client.query(`INSERT INTO returns.customer_return_intakes
      (authorization_id,settings_version,policy_id,policy_version,operational_policy_snapshot,created_at)
      VALUES(1,1,1,1,$1,$2)`, [JSON.stringify(INTAKE_POLICY), INTAKE_NOW]);
    await client.query(`INSERT INTO wms.returns(id,order_id,source,status,source_event_key,created_at,updated_at)
      OVERRIDING SYSTEM VALUE VALUES(1,201,'customer_portal','expected','customer-return:1:201',$1,$1)`, [INTAKE_NOW]);
    await client.query(`INSERT INTO wms.return_items
      (id,return_id,order_item_id,oms_order_line_id,external_line_item_id,sku,expected_qty,restock_policy,created_at,updated_at)
      OVERRIDING SYSTEM VALUE VALUES(1,1,301,101,'500','SAME',1,'return',$1,$1)`, [INTAKE_NOW]);
    await client.query(`INSERT INTO returns.return_cases
      (id,source_provider,source_event_type,source_event_id,business_context,channel_id,oms_order_id,wms_order_id,wms_return_id,
        policy_id,policy_version,policy_snapshot,case_status,approval_status,logistics_status,inspection_status,
        customer_refund_status,vendor_settlement_status,opened_at,created_at,updated_at)
      OVERRIDING SYSTEM VALUE VALUES(1,'customer_portal','private_customer_return','1:201','retail',36,100,201,1,
        1,1,$1,'open','approved','awaiting_return','pending','pending','not_applicable',$2,$2,$2)`, [JSON.stringify(INTAKE_POLICY), INTAKE_NOW]);
    await client.query(`INSERT INTO returns.customer_return_case_links
      (authorization_id,case_id,wms_order_id,wms_return_id,created_at) VALUES(1,1,201,1,$1)`, [INTAKE_NOW]);
    await client.query(`INSERT INTO returns.return_case_items
      (id,return_case_id,wms_return_item_id,oms_order_line_id,wms_order_item_id,external_line_item_id,sku,title,quantity,
        unit_paid_price_cents,source_line_total_cents,created_at)
      OVERRIDING SYSTEM VALUE VALUES(1,1,1,101,301,'500','SAME','Same title',1,125,125,$1)`, [INTAKE_NOW]);
    await client.query(`INSERT INTO returns.customer_return_allocation_case_items
      (authorization_id,authorization_allocation_id,case_item_id,wms_return_item_id,created_at) VALUES(1,1,1,1,$1)`, [INTAKE_NOW]);
    const parcel = prepared.parcels[0];
    await client.query(`INSERT INTO returns.customer_return_parcels
      (id,authorization_id,parcel_key,dimensions,weight_grams,origin_address,destination_address,carrier_id,service_code,created_at)
      OVERRIDING SYSTEM VALUE VALUES(1,1,'1',$1,$2,$3,$4,$5,$6,$7)`,
      [JSON.stringify(parcel.dimensions), parcel.weightGrams, JSON.stringify(parcel.originAddress), JSON.stringify(parcel.destinationAddress),
        parcel.carrierId, parcel.serviceCode, INTAKE_NOW]);
    await client.query(`INSERT INTO returns.customer_return_parcel_items(parcel_id,authorization_line_id,quantity) VALUES(1,1,1)`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export function preparedIntake(): PreparedCustomerReturnIntake & { now: Date } {
  const allocation = (wmsOrderItemId: number, suffix: string, quantity: number) => ({
    wmsOrderItemId, quantity, originalQuantity: quantity,
    eligibleQuantity: quantity, fulfillmentId: `gid://shopify/Fulfillment/${suffix}`, fulfillmentLineItemId: `gid://shopify/FulfillmentLineItem/${suffix}`,
    deliveryEvidence: { source: "shopify", status: "delivered" }
  });
  return {
    channelId: 36, omsOrderId: 100, idempotencyKey: INTAKE_KEY, submissionLeaseToken: INTAKE_LEASE,
    semanticHash: "a".repeat(64), eligibilityRevision: "b".repeat(64), actor: "admin:test", observedAt: INTAKE_NOW.toISOString(), now: new Date(INTAKE_NOW), settingsVersion: 1,
    policySnapshot: { version: 1, returnWindowDays: 365, refundAuthority: "manual_shopify", windowBasis: "purchase" },
    warehouseSnapshot: { warehouseId: 1, version: 1, address: INTAKE_ADDRESS }, operationalPolicy: { id: 1, version: 1, snapshot: { ...INTAKE_POLICY } },
    lines: [
      { omsOrderLineId: 101, externalLineItemId: "500", quantity: 3, reasonCode: null, allocations: [allocation(301, "700", 2), allocation(302, "701", 1)] },
      { omsOrderLineId: 102, externalLineItemId: "501", quantity: 1, reasonCode: null, allocations: [allocation(303, "702", 1)] },
    ], expectedClaims: [301, 302, 303].map(wmsOrderItemId => ({ wmsOrderItemId, legacyExpectedQuantity: 0, claimedQuantity: 0 })),
    parcels: [{
      parcelKey: "1", selectionMode: "fixed_service", dimensions: { lengthMm: 100, widthMm: 120, heightMm: 150 }, weightGrams: 25,
      originAddress: { ...INTAKE_ADDRESS, name: "Test customer" }, destinationAddress: { ...INTAKE_ADDRESS }, carrierId: "se-123", serviceCode: "usps_ground_advantage",
      items: [{ omsOrderLineId: 101, quantity: 2 }]
    },
    {
      parcelKey: "2", selectionMode: "fixed_service", dimensions: { lengthMm: 200, widthMm: 200, heightMm: 200 }, weightGrams: 33,
      originAddress: { ...INTAKE_ADDRESS, name: "Test customer" }, destinationAddress: { ...INTAKE_ADDRESS }, carrierId: "se-123", serviceCode: "usps_ground_advantage",
      items: [{ omsOrderLineId: 101, quantity: 1 }, { omsOrderLineId: 102, quantity: 1 }]
    }],
  };
}
