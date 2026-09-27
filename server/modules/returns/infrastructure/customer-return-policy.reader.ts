import { sql } from "drizzle-orm";
import type { ReturnPolicy } from "@shared/schema";
import type { CustomerReturnPortalPolicyReader } from "../application/customer-return-policy";
import { CustomerReturnIntakeError } from "../application/customer-return-intake.ports";
import type {
  CustomerReturnAuthorizationDatabase,
  CustomerReturnAuthorizationSqlExecutor,
} from "./customer-return-authorization.repository";
import { acquireReturnPolicyCatalogLock } from "./return-policy-lock";

/** Caller holds the catalog lock. Filter only resolution scope, never operational
 * compatibility: an unsupported winning policy must block the portal. */
export async function readCustomerReturnPolicyCandidates(
  tx: CustomerReturnAuthorizationSqlExecutor,
  channelId: number,
): Promise<ReturnPolicy[]> {
  const result =
    await tx.execute(sql`SELECT id,name,scope_kind AS "scopeKind",scope_key AS "scopeKey",
    business_context AS "businessContext",channel_id AS "channelId",vendor_id AS "vendorId",store_connection_id AS "storeConnectionId",
    version,status,return_window_days AS "returnWindowDays",return_destination AS "returnDestination",approval_authority AS "approvalAuthority",
    label_provider AS "labelProvider",return_shipping_payer AS "returnShippingPayer",inspection_requirement AS "inspectionRequirement",
    inspection_owner AS "inspectionOwner",customer_refund_authority AS "customerRefundAuthority",vendor_settlement_trigger AS "vendorSettlementTrigger",
    returnless_refund_allowed AS "returnlessRefundAllowed",notes,supersedes_policy_id AS "supersedesPolicyId",created_by AS "createdBy",
    retired_by AS "retiredBy",retired_at AS "retiredAt",created_at AS "createdAt"
    FROM returns.return_policies WHERE status='active'
      AND (business_context IS NULL OR business_context='retail') AND (channel_id IS NULL OR channel_id=${channelId})
      AND vendor_id IS NULL AND store_connection_id IS NULL ORDER BY id LIMIT 201`);
  const rows = Array.isArray(result)
    ? result
    : (result as { rows?: unknown })?.rows;
  if (!Array.isArray(rows) || rows.length > 200)
    throw new CustomerReturnIntakeError(
      "RETURN_PORTAL_POLICY_CATALOG_INVALID",
      "The return policy catalog needs administrator attention.",
      503,
    );
  // Database constraints define row shapes; application resolution validates the
  // complete scope and operational snapshot before anything can authorize units.
  return rows as ReturnPolicy[];
}

export class PostgresCustomerReturnPortalPolicyReader
  implements CustomerReturnPortalPolicyReader
{
  constructor(private readonly database: CustomerReturnAuthorizationDatabase) {}
  read(channelId: number): Promise<ReturnPolicy[]> {
    return this.database.transaction(async (tx) => {
      await acquireReturnPolicyCatalogLock(tx, "shared");
      return readCustomerReturnPolicyCandidates(tx, channelId);
    });
  }
}
