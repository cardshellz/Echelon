/**
 * Pure storefront/staging configuration contract for `customer-account` (CI-03).
 * Free of infrastructure and HTTP interface imports.
 */
export {
  readCustomerAccountStagingConfig,
  requireCustomerAccountStorefront,
  type CustomerAccountStagingConfig,
} from "./domain/customer-account-staging";
