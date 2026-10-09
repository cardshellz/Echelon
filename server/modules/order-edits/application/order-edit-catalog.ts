import type {
  OrderEditCatalogCategories,
  OrderEditCatalogCategoriesInput,
  OrderEditCatalogProducts,
  OrderEditCatalogProductsInput,
  OrderEditCatalogVariants,
  OrderEditCatalogVariantsInput,
} from "@shared/order-edits/order-edit-catalog";
import type { OrderEditSnapshot } from "./order-edit-provider";

export type OrderEditCatalogPricingContext = Pick<
  OrderEditSnapshot,
  "connectionId" | "customerId" | "memberPlan" | "memberPricingEnabled"
>;

/** Discovery only. Quote and commit must re-read prices, discounts and stock. */
export interface OrderEditCatalog {
  categories(
    connectionId: number,
    input: OrderEditCatalogCategoriesInput,
  ): Promise<OrderEditCatalogCategories>;
  products(
    connectionId: number,
    input: OrderEditCatalogProductsInput,
  ): Promise<OrderEditCatalogProducts>;
  productVariants(
    connectionId: number,
    input: OrderEditCatalogVariantsInput,
    pricingContext?: OrderEditCatalogPricingContext,
  ): Promise<OrderEditCatalogVariants>;
}
