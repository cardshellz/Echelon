import { createShopifyStaffOAuthService, type ShopifyStaffOAuthService } from "./application/shopify-staff-oauth.service";
import { parseShopifyStaffOAuthConfig } from "./domain/shopify-staff-oauth";
import { exchangeShopifyStaffOAuthCode } from "./adapters/shopify/shopify-staff-oauth.provider";
import { PostgresShopifyStaffOAuthRepository } from "./infrastructure/shopify-staff-oauth.repository";
import { logger } from "../../platform/observability/logger";

export type { ShopifyStaffOAuthService } from "./application/shopify-staff-oauth.service";
export { ShopifyStaffOAuthError } from "./shopify-staff-oauth.types";

let service: ShopifyStaffOAuthService | undefined;
/** Public Channels command composition; importing routes does not open a pool. */
export async function getShopifyStaffOAuthService(): Promise<ShopifyStaffOAuthService> {
  if (service) return service;
  const [{ db }, { readCommandAuthorityActor }] = await Promise.all([
    import("../../db"), import("../identity"),
  ]);
  service ??= createShopifyStaffOAuthService({
    repository: new PostgresShopifyStaffOAuthRepository(db, readCommandAuthorityActor),
    readConfig: () => parseShopifyStaffOAuthConfig(process.env),
    exchange: exchangeShopifyStaffOAuthCode,
    telemetry: event => {
      const { action, ...data } = event;
      const release = process.env.HEROKU_RELEASE_VERSION || process.env.SOURCE_VERSION || "unknown";
      logger.info(action, { ...data, correlationId: event.operationId, releaseVersion: release });
    },
  });
  return service;
}
