import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { warehouses } from "@shared/schema";
import { PostgresCustomerReturnPortalPolicyReader } from "./customer-return-policy.reader";
import {
  customerReturnLabelSettingsSchema,
  customerReturnLabelControlSchema,
  customerReturnLabelControlInputSchema,
} from "@shared/returns/customer-return-label.contract";
import {
  type CustomerReturnSettingsStore,
} from "../application/customer-return-label-settings.service";
import { CustomerReturnIntakeError } from "../application/customer-return-intake.ports";
import type { db } from "../../../db";
import { acquireReturnPolicyCatalogLock } from "./return-policy-lock";
import { readCustomerReturnPolicyCandidates } from "./customer-return-policy.reader";
import { resolveCustomerReturnPortalPolicy } from "../application/customer-return-policy";

type Database = typeof db;
export const RETURN_LABEL_CONTROL_LOCK_NAMESPACE = 924110;
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
    return this.database.transaction(async tx => {
      await acquireReturnPolicyCatalogLock(tx, "shared");
      const resolved = resolveCustomerReturnPortalPolicy(await readCustomerReturnPolicyCandidates(tx, channelId), channelId);
      if (!resolved.policy) return null;
      const result = await tx.execute(sql`SELECT configuration FROM returns.return_policy_shipping WHERE policy_id=${resolved.policy.id}`);
      const configuration = result.rows[0]?.configuration;
      return configuration == null ? null : customerReturnLabelSettingsSchema.parse(configuration);
    });
  }

  async readAccepted(channelId: number, authorizationId: number) {
    const result = await this.database.execute(sql`SELECT s.policy_id AS shipping_policy_id,s.configuration
      FROM returns.customer_return_authorizations a JOIN returns.customer_return_intakes i ON i.authorization_id=a.id
      LEFT JOIN returns.return_policy_shipping s ON s.policy_id=i.policy_id
      WHERE a.channel_id=${channelId} AND a.id=${authorizationId}`);
    const row = result.rows[0];
    if (!row) throw new CustomerReturnIntakeError("RETURN_LABEL_NOT_FOUND", "This return could not be found.", 404);
    if (row.shipping_policy_id != null) return row.configuration === null ? null : customerReturnLabelSettingsSchema.parse(row.configuration);
    // Only accepted returns from before policy-owned shipping can use legacy
    // channel settings. New intake never reads these rows as shipping authority.
    return this.readLegacy(channelId);
  }

  private async readLegacy(channelId: number) {
    const result = await this.database
      .execute(sql`SELECT version,enabled,warehouse_id AS "warehouseId",
      selection_mode AS "selectionMode",carrier_rules AS "carrierRules",
      carrier_id AS "carrierId",service_code AS "serviceCode",contact_name AS "contactName",contact_phone AS "contactPhone",
      destination_address AS "destinationAddress" FROM returns.customer_return_settings WHERE channel_id=${channelId}`);
    return result.rows[0]
      // Migration copied the old enabled flag into the independent pause control.
      // That control is now the sole pause authority for this historical intake;
      // retaining the retired writer's flag would make Resume ineffective.
      ? customerReturnLabelSettingsSchema.parse({ ...result.rows[0], enabled: true })
      : null;
  }

  async readControl(channelId: number) {
    const result = await this.database.execute(sql`SELECT paused,version FROM returns.customer_return_label_controls WHERE channel_id=${channelId}`);
    return customerReturnLabelControlSchema.parse(result.rows[0] ?? { paused: false, version: 0 });
  }

  async saveControl(channelId: number, raw: z.infer<typeof customerReturnLabelControlInputSchema>, actor: string, now: Date) {
    const input = customerReturnLabelControlInputSchema.parse(raw);
    if (!actor.trim() || !Number.isFinite(now.getTime())) throw new CustomerReturnIntakeError("RETURN_LABEL_ACTOR_INVALID", "The administrator session needs verification.", 403);
    await this.database.transaction(async tx => {
      // Advisory locking protects the initially absent row as well as updates.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${RETURN_LABEL_CONTROL_LOCK_NAMESPACE},${channelId})`);
      const result = await tx.execute(sql`SELECT paused,version FROM returns.customer_return_label_controls WHERE channel_id=${channelId} FOR UPDATE`);
      const before = customerReturnLabelControlSchema.parse(result.rows[0] ?? { paused: false, version: 0 });
      if (before.version !== input.expectedVersion || before.version >= 2_147_483_647) throw new CustomerReturnIntakeError("RETURN_LABEL_CONTROL_CHANGED", "Another administrator changed label controls. Refresh before trying again.");
      const after = { paused: input.paused, version: before.version + 1 };
      await tx.execute(sql`INSERT INTO returns.customer_return_label_controls(channel_id,paused,version,updated_by,updated_at)
        VALUES(${channelId},${after.paused},${after.version},${actor},${now})
        ON CONFLICT(channel_id) DO UPDATE SET paused=EXCLUDED.paused,version=EXCLUDED.version,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`);
      await tx.execute(sql`INSERT INTO returns.customer_return_label_control_events(channel_id,version,actor,before_snapshot,after_snapshot,occurred_at)
        VALUES(${channelId},${after.version},${actor},${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb,${now})`);
    });
  }
  async catalog(channelId: number, includePolicies = true) {
    const [warehouseRows, policies] = await Promise.all([
      this.database
        .select(warehouseFields)
        .from(warehouses)
        .where(eq(warehouses.isActive, 1))
        .limit(201),
      includePolicies ? new PostgresCustomerReturnPortalPolicyReader(this.database).read(channelId) : Promise.resolve([]),
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
}
