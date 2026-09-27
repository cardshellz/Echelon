import { eq, sql } from "drizzle-orm";
import { warehouses } from "@shared/schema";
import { PostgresCustomerReturnPortalPolicyReader } from "./customer-return-policy.reader";
import {
  customerReturnLabelSettingsSchema,
  customerReturnLabelSettingsInputSchema,
  type CustomerReturnLabelSettingsInput,
} from "@shared/returns/customer-return-label.contract";
import {
  warehouseLabelAddress,
  type CustomerReturnSettingsStore,
} from "../application/customer-return-label-settings.service";
import { CustomerReturnIntakeError } from "../application/customer-return-intake.ports";
import {
  customerReturnCarrierRulesSchema,
  normalizeCustomerReturnCarrierRules,
} from "@shared/returns/customer-return-carrier-policy";
import type { db } from "../../../db";

type Database = typeof db;
const SETTINGS_LOCK_NAMESPACE = 918420;
const warehouseFields = {
  id: warehouses.id,
  name: warehouses.name,
  address: warehouses.address,
  city: warehouses.city,
  state: warehouses.state,
  postalCode: warehouses.postalCode,
  country: warehouses.country,
  isActive: warehouses.isActive,
};
export class PostgresCustomerReturnSettingsStore
  implements CustomerReturnSettingsStore
{
  constructor(private readonly database: Database) {}

  async read(channelId: number) {
    const result = await this.database
      .execute(sql`SELECT version,enabled,warehouse_id AS "warehouseId",
      selection_mode AS "selectionMode",carrier_rules AS "carrierRules",
      carrier_id AS "carrierId",service_code AS "serviceCode",contact_name AS "contactName",contact_phone AS "contactPhone",
      destination_address AS "destinationAddress" FROM returns.customer_return_settings WHERE channel_id=${channelId}`);
    return result.rows[0]
      ? customerReturnLabelSettingsSchema.parse(result.rows[0])
      : null;
  }
  async catalog(channelId: number) {
    const [warehouseRows, policies] = await Promise.all([
      this.database
        .select(warehouseFields)
        .from(warehouses)
        .where(eq(warehouses.isActive, 1))
        .limit(201),
      new PostgresCustomerReturnPortalPolicyReader(this.database).read(
        channelId,
      ),
    ]);
    if (warehouseRows.length > 200 || policies.length > 200)
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_CATALOG_LIMIT",
        "Return configuration needs administrator attention.",
        503,
      );
    return {
      warehouses: warehouseRows,
      policies: policies.filter(
        (policy) => policy.channelId === null || policy.channelId === channelId,
      ),
    };
  }
  async save(
    channelId: number,
    raw: CustomerReturnLabelSettingsInput,
    actor: string,
    now: Date,
  ) {
    const input = customerReturnLabelSettingsInputSchema.parse(raw);
    if (!actor.trim() || !Number.isFinite(now.getTime()))
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_ACTOR_INVALID",
        "The administrator session needs verification.",
        403,
      );
    return this.database.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${SETTINGS_LOCK_NAMESPACE},${channelId})`,
      );
      const before = (
        await tx.execute(
          sql`SELECT * FROM returns.customer_return_settings WHERE channel_id=${channelId} FOR UPDATE`,
        )
      ).rows[0];
      const currentVersion = before ? Number(before.version) : 0;
      if (
        currentVersion !== input.expectedVersion ||
        currentVersion >= 2_147_483_647
      )
        throw new CustomerReturnIntakeError(
          "RETURN_LABEL_SETTINGS_CHANGED",
          "Another administrator changed these settings. Reload them before saving.",
        );
      // Pausing the same configuration must remain possible during a provider outage
      // or after a policy is retired. It cannot silently replace other saved fields.
      const pauseOnly =
        before &&
        !input.enabled &&
        input.warehouseId === before.warehouse_id &&
        input.selectionMode === before.selection_mode &&
        JSON.stringify(
          normalizeCustomerReturnCarrierRules(input.carrierRules),
        ) ===
          JSON.stringify(
            normalizeCustomerReturnCarrierRules(
              customerReturnCarrierRulesSchema.parse(before.carrier_rules),
            ),
          ) &&
        input.carrierId === before.carrier_id &&
        input.serviceCode === before.service_code &&
        input.contactName === before.contact_name &&
        input.contactPhone === before.contact_phone;
      const [warehouse] = await tx
        .select(warehouseFields)
        .from(warehouses)
        .where(eq(warehouses.id, input.warehouseId))
        .for("share");
      const destination = pauseOnly
        ? before.destination_address
        : warehouse && warehouse.isActive === 1
          ? warehouseLabelAddress(
              warehouse,
              input.contactName,
              input.contactPhone,
            )
          : null;
      if (!destination)
        throw new CustomerReturnIntakeError(
          "RETURN_LABEL_CONFIGURATION_INVALID",
          "Choose an active U.S. warehouse with a complete address.",
        );
      const { expectedVersion: _expected, ...fields } = input;
      const after = customerReturnLabelSettingsSchema.parse({
        ...fields,
        carrierRules: normalizeCustomerReturnCarrierRules(fields.carrierRules),
        version: currentVersion + 1,
        destinationAddress: destination,
      });
      await tx.execute(sql`INSERT INTO returns.customer_return_settings
        (channel_id,version,enabled,warehouse_id,policy_id,selection_mode,carrier_rules,carrier_id,service_code,destination_address,contact_name,contact_phone,updated_by,updated_at)
        VALUES (${channelId},${after.version},${after.enabled},${after.warehouseId},NULL,${after.selectionMode},${JSON.stringify(normalizeCustomerReturnCarrierRules(after.carrierRules))}::jsonb,${after.carrierId},${after.serviceCode},
          ${JSON.stringify(after.destinationAddress)}::jsonb,${after.contactName},${after.contactPhone},${actor},${now})
        ON CONFLICT(channel_id) DO UPDATE SET version=EXCLUDED.version,enabled=EXCLUDED.enabled,warehouse_id=EXCLUDED.warehouse_id,
          policy_id=EXCLUDED.policy_id,selection_mode=EXCLUDED.selection_mode,carrier_rules=EXCLUDED.carrier_rules,
          carrier_id=EXCLUDED.carrier_id,service_code=EXCLUDED.service_code,destination_address=EXCLUDED.destination_address,
          contact_name=EXCLUDED.contact_name,contact_phone=EXCLUDED.contact_phone,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`);
      await tx.execute(sql`INSERT INTO returns.customer_return_settings_events(channel_id,version,actor,before_snapshot,after_snapshot,occurred_at)
        VALUES(${channelId},${after.version},${actor},${before ? JSON.stringify(before) : null}::jsonb,${JSON.stringify(after)}::jsonb,${now})`);
      return after;
    });
  }
}
