import { z } from "zod";

/** Classification is independent of the address's name, company and physical location. */
export const shippingAddressTypeSchema = z.enum(["commercial", "residential", "unknown"]);
export type ShippingAddressType = z.infer<typeof shippingAddressTypeSchema>;
