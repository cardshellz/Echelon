import { randomBytes } from "node:crypto";
import { CustomerReturnCustomerAuthService, readReturnCustomerAuthConfig } from "../application/customer-return-customer-auth.service";
import { PostgresReturnLoginChallengeStore } from "./customer-return-customer-auth.repository";
import { PostgresCustomerReturnLocalInspectionReader } from "./customer-return-local-inspection.reader";
import { parseCustomerReturnShopDomains } from "./customer-return-live.composition";

/** No customer route or provider is opened by merely importing this module. */
export async function createCustomerReturnCustomerAuth() {
  const config = readReturnCustomerAuthConfig(process.env);
  const { pool } = await import("../../../db");
  const now = () => new Date();
  const local = new PostgresCustomerReturnLocalInspectionReader(pool, {
    approvedShopDomains: parseCustomerReturnShopDomains(process.env.CUSTOMER_RETURN_SHOPIFY_DOMAINS), clock: now,
  });
  return { config, auth: new CustomerReturnCustomerAuthService({ config,
    challenges: new PostgresReturnLoginChallengeStore(pool), shops: () => local.listShops(), now,
    randomState: () => randomBytes(32).toString("base64url") }) };
}
