import type { OrderEditSnapshot } from "./order-edit-provider";
import type { OrderEditShippingRepricing } from "@shared/order-edits/order-edit-shipping";

export interface OrderEditShippingContext {
  address: {
    address1: string | null;
    address2: string | null;
    city: string | null;
    provinceCode: string | null;
    zip: string | null;
    countryCodeV2: string | null;
  };
  lines: Array<{
    id: string;
    title: string;
    code: string | null;
    source: string | null;
    grossCents: number;
    netCents: number;
  }>;
}

export interface OrderEditShippingItem {
  variantId: string;
  quantity: number;
  netCents: number;
}

/** Reevaluate checkout delivery pricing without creating an order or collecting payment. */
export interface OrderEditShippingCalculator {
  calculate(
    snapshot: OrderEditSnapshot,
    items: OrderEditShippingItem[],
  ): Promise<OrderEditShippingRepricing>;
}
