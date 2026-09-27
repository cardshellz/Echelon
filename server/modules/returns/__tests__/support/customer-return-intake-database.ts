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

export async function createIntakeTestSchema(pool: Pool): Promise<void> {
  await createInspectionTestSchema(pool);
  await pool.query(readFileSync("migrations/059_wms_order_items_prices.sql", "utf8"));
  await pool.query(readFileSync("migrations/251_customer_return_label_settings.sql", "utf8"));
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
      parcelKey: "1", dimensions: { lengthMm: 100, widthMm: 120, heightMm: 150 }, weightGrams: 25,
      originAddress: { ...INTAKE_ADDRESS, name: "Test customer" }, destinationAddress: { ...INTAKE_ADDRESS }, carrierId: "se-123", serviceCode: "usps_ground_advantage",
      items: [{ omsOrderLineId: 101, quantity: 2 }]
    },
    {
      parcelKey: "2", dimensions: { lengthMm: 200, widthMm: 200, heightMm: 200 }, weightGrams: 33,
      originAddress: { ...INTAKE_ADDRESS, name: "Test customer" }, destinationAddress: { ...INTAKE_ADDRESS }, carrierId: "se-123", serviceCode: "usps_ground_advantage",
      items: [{ omsOrderLineId: 101, quantity: 1 }, { omsOrderLineId: 102, quantity: 1 }]
    }],
  };
}
