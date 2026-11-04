import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { ShopifyOrderEditProvider } from "../../order-edits/infrastructure/shopify-order-edit.provider";
import { createOrderEditCredentialStore } from "../../order-edits/infrastructure/order-edit-credential-store";
import { readCustomerAccountStagingConfig } from "../domain/customer-account-staging";
import { AccountNativeSummariesWorker } from "../application/account-native-summaries.worker";
import { PostgresAccountNativeSummaries } from "./account-native-summaries.repository";
import type { OrderActionProjectionReport } from "./order-action-projection.composition";

export function createAccountNativeSummariesWorker(
  pool: Pool,
  report: OrderActionProjectionReport,
) {
  const config = readCustomerAccountStagingConfig(
    process.env.CUSTOMER_ACCOUNT_STAGING_CONFIG,
  );
  const shops = Object.entries(config?.shops ?? {})
    .filter(([, shop]) => shop.enabled)
    .map(([domain]) => domain);
  const now = () => new Date();
  const provider = new ShopifyOrderEditProvider({
    credentials: createOrderEditCredentialStore(pool, now),
    clock: now,
  });
  return new AccountNativeSummariesWorker({
    store: new PostgresAccountNativeSummaries(pool, shops),
    now,
    newId: randomUUID,
    provider: {
      page: (...args) => provider.accountNativePage(...args),
      byIds: (...args) => provider.accountNativeByIds(...args),
    },
    report: ({ code, ...event }) =>
      report({ action: "account_native_summaries", code, ...event }),
  });
}
