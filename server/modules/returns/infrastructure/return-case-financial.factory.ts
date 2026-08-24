import { ReturnCaseFinancialService } from "../application/return-case-financial.service";
import { DropshipVendorSettlementQuoteProvider } from "./dropship-vendor-settlement-quote.provider";
import {
  PostgresReturnCaseCustomerRefundStore,
  PostgresReturnCaseFinancialSourceStore,
  PostgresReturnCaseVendorSettlementStore,
} from "./return-case-financial.repository";
import { ShopifyCustomerRefundProvider } from "./shopify-customer-refund.provider";

/**
 * Production composition root for context-specific Return Case financial actions.
 * Provider/API and wallet adapters remain outside the application service so
 * tests can replace every external or stateful dependency deterministically.
 */
export function createReturnCaseFinancialServiceFromEnv(): ReturnCaseFinancialService {
  return new ReturnCaseFinancialService(
    new PostgresReturnCaseFinancialSourceStore(),
    new PostgresReturnCaseCustomerRefundStore(),
    new ShopifyCustomerRefundProvider(),
    new DropshipVendorSettlementQuoteProvider(),
    new PostgresReturnCaseVendorSettlementStore(),
  );
}
