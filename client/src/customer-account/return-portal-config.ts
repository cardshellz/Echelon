import { z } from "zod";
import { customerAccountPageConfigSchema } from "./customer-account.transport";

// Liquid selects the view; only Shopify's signed proxy identity authorizes reads
// and commands. Guests must not construct a customer-scoped API transport.
export const returnPortalPageConfigSchema = customerAccountPageConfigSchema.extend({
  customerId: customerAccountPageConfigSchema.shape.customerId.nullable(),
  logoutPath: z.string().max(100).regex(/^\/(?:[a-z]{2}(?:-[a-z0-9]{2,8})?\/)?account\/logout$/i),
}).strict();
export type ReturnPortalPageConfig = z.infer<typeof returnPortalPageConfigSchema>;
