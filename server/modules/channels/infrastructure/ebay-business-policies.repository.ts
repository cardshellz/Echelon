import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  EMPTY_EBAY_POLICIES,
  EbayBusinessPolicyError,
  ebayPolicyValuesSchema,
  type EbayPolicyScope,
  type EbayPolicyValues,
} from "@shared/ebay-business-policies";
import type {
  EbayBusinessPolicyRepository,
  EbayPolicyTransaction,
  EbayPolicyTarget,
  EbayCategoryMappingPatch,
} from "../ebay-business-policies.service";
import {
  readCatalogEbayPolicyFields,
  readCatalogEbayPolicySelection,
  writeCatalogEbayPolicyFields,
} from "../../catalog/catalog-ebay-policy-fields";

const categoryColumns =
  'fulfillment_policy_override AS "fulfillmentPolicyId", return_policy_override AS "returnPolicyId", payment_policy_override AS "paymentPolicyId"';
function values(row: Record<string, unknown>): EbayPolicyValues {
  return ebayPolicyValuesSchema.parse({
    fulfillmentPolicyId: row.fulfillmentPolicyId ?? null,
    returnPolicyId: row.returnPolicyId ?? null,
    paymentPolicyId: row.paymentPolicyId ?? null,
  });
}
function targetKey(target: EbayPolicyTarget, scope: EbayPolicyScope): string {
  return target.kind === "store"
    ? `channels.channel_connections:${scope.connectionId}`
    : target.kind === "category"
      ? `ebay.category_mapping:${scope.channelId}:${target.productTypeSlug}`
      : target.kind === "product"
        ? `catalog.products:${target.productId}`
        : `catalog.product_variants:${target.variantId}`;
}

export class PgEbayBusinessPolicyRepository
  implements EbayBusinessPolicyRepository
{
  constructor(private readonly pool: Pool) {}
  async withScope<T>(
    scope: EbayPolicyScope,
    run: (transaction: EbayPolicyTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let transactionStarted = false;
    let committing = false;
    let discardClient = false;
    try {
      await client.query("BEGIN");
      transactionStarted = true;
      const connections = await client.query<{
        id: number;
        metadata: Record<string, unknown> | null;
      }>(
        "SELECT id,metadata FROM channels.channel_connections WHERE channel_id=$1 ORDER BY id FOR UPDATE",
        [scope.channelId],
      );
      const connection = connections.rows[0];
      const tokens = await client.query(
        "SELECT external_account_id,external_account_identity_scheme,external_account_verified_at FROM ebay.ebay_oauth_tokens WHERE channel_id=$1 AND environment=$2 FOR SHARE",
        [scope.channelId, scope.environment],
      );
      if (
        connections.rows.length !== 1 ||
        connection.id !== scope.connectionId ||
        (connection.metadata?.marketplaceId ?? "EBAY_US") !==
          scope.marketplaceId ||
        tokens.rows.length !== 1 ||
        tokens.rows[0].external_account_id !== scope.accountId ||
        tokens.rows[0].external_account_identity_scheme !==
          "provider_user_id" ||
        !tokens.rows[0].external_account_verified_at
      )
        throw new EbayBusinessPolicyError(
          "EBAY_POLICY_SCOPE_CHANGED",
          "The eBay account or marketplace changed. Refresh Connection settings before continuing.",
          409,
        );
      const tx = this.transaction(client, scope, connection.metadata ?? {});
      const result = await run(tx);
      committing = true;
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      // A failed transaction-control response can leave the session state
      // unknown. Never return that connection to the pool or replace the
      // original business/persistence error with a secondary rollback failure.
      discardClient = !transactionStarted || committing;
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
        } catch {
          discardClient = true;
          console.error(JSON.stringify({
            event: "ebay_policy_rollback_failed",
            channelId: scope.channelId,
            connectionId: scope.connectionId,
          }));
        }
      }
      throw error;
    } finally {
      client.release(discardClient);
    }
  }
  private transaction(
    client: PoolClient,
    scope: EbayPolicyScope,
    metadata: Record<string, unknown>,
  ): EbayPolicyTransaction {
    const audit = async (
      target: EbayPolicyTarget,
      before: Record<string, unknown>,
      after: Record<string, unknown>,
      actor: string,
      now: Date,
    ) =>
      persistAuditEvent(
        drizzle(client),
        {
          actor,
          action: "ebay.business_policies.changed",
          target: targetKey(target, scope),
          changes: { before, after },
          context: { scope, policyTarget: target },
        },
        { timestamp: now, emitStructuredLog: false },
      );
    const readPolicies = async (
      target: EbayPolicyTarget,
    ): Promise<EbayPolicyValues> => {
      if (target.kind === "store") return values(metadata);
      if (target.kind === "product" || target.kind === "variant")
        return readCatalogEbayPolicyFields(client, target);
      const result = await client.query(
        `SELECT ${categoryColumns} FROM ebay.ebay_category_mappings WHERE channel_id=$1 AND product_type_slug=$2 FOR UPDATE`,
        [scope.channelId, target.productTypeSlug],
      );
      if (!result.rows.length) return { ...EMPTY_EBAY_POLICIES };
      return values(result.rows[0]);
    };
    const saveCategoryMapping = async (
      mapping: EbayCategoryMappingPatch,
      actor: string,
      now: Date,
      auditChange = true,
    ) => {
      const existing = await client.query(
        "SELECT * FROM ebay.ebay_category_mappings WHERE channel_id=$1 AND product_type_slug=$2 FOR UPDATE",
        [scope.channelId, mapping.productTypeSlug],
      );
      const before = existing.rows[0] ?? {
        ebay_browse_category_id: null,
        ebay_browse_category_name: null,
        ebay_store_category_id: null,
        ebay_store_category_name: null,
        fulfillment_policy_override: null,
        return_policy_override: null,
        payment_policy_override: null,
        listing_enabled: true,
      };
      const fields = {
        ebayBrowseCategoryId: "ebay_browse_category_id",
        ebayBrowseCategoryName: "ebay_browse_category_name",
        ebayStoreCategoryId: "ebay_store_category_id",
        ebayStoreCategoryName: "ebay_store_category_name",
        fulfillmentPolicyOverride: "fulfillment_policy_override",
        returnPolicyOverride: "return_policy_override",
        paymentPolicyOverride: "payment_policy_override",
        listingEnabled: "listing_enabled",
      } as const;
      const beforeState = Object.fromEntries(
          Object.values(fields).map((column) => [column, before[column]]),
        ),
        after = { ...beforeState };
      for (const [key, column] of Object.entries(fields)) {
        const value = mapping[key as keyof typeof fields];
        if (value !== undefined) after[column] = value;
      }
      if (
        existing.rows.length &&
        Object.keys(after).every((key) => after[key] === beforeState[key])
      )
        return;
      const columns = Object.values(fields);
      await client.query(
        `INSERT INTO ebay.ebay_category_mappings(channel_id,product_type_slug,${columns.join(",")},created_at,updated_at) VALUES($1,$2,${columns.map((_, index) => `$${index + 3}`).join(",")},$11,$11) ON CONFLICT(channel_id,product_type_slug) DO UPDATE SET ${columns.map((column) => `${column}=EXCLUDED.${column}`).join(",")},updated_at=EXCLUDED.updated_at`,
        [
          scope.channelId,
          mapping.productTypeSlug,
          ...columns.map((column) => after[column]),
          now,
        ],
      );
      if (auditChange)
        await audit(
          { kind: "category", productTypeSlug: mapping.productTypeSlug },
          beforeState,
          after,
          actor,
          now,
        );
    };
    return {
      readPolicies,
      async writePolicies(target, before, after, actor, now) {
        if (target.kind === "store") {
          Object.assign(metadata, after);
          await client.query(
            "UPDATE channels.channel_connections SET metadata=$2::jsonb,updated_at=$3 WHERE id=$1",
            [scope.connectionId, JSON.stringify(metadata), now],
          );
        } else if (target.kind === "category") {
          await saveCategoryMapping(
            {
              productTypeSlug: target.productTypeSlug,
              fulfillmentPolicyOverride: after.fulfillmentPolicyId,
              returnPolicyOverride: after.returnPolicyId,
              paymentPolicyOverride: after.paymentPolicyId,
            },
            actor,
            now,
            false,
          );
        } else await writeCatalogEbayPolicyFields(client, target, after, now);
        await audit(target, before, after, actor, now);
      },
      readProductSelection: (productId, variantIds) =>
        readCatalogEbayPolicySelection(client, productId, variantIds),
      saveCategoryMapping,
    };
  }
}
