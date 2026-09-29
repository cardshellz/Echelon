import { z } from "zod";
import { customerReturnCustomerProfileSchema, type CustomerReturnCustomerProfile } from "@shared/returns/customer-return-access.contract";
import { customerReturnCustomerIdSchema, customerReturnShopSchema } from "../domain/customer-return-shopify-proof";
import type { CustomerReturnCustomerSession } from "./customer-return-customer-auth.service";

export const customerReturnCustomerProfileScopeSchema = z.object({
  channelId: z.number().int().positive().safe(),
  shopDomain: customerReturnShopSchema,
  externalCustomerId: customerReturnCustomerIdSchema,
}).strict();
export type CustomerReturnCustomerProfileScope = z.infer<typeof customerReturnCustomerProfileScopeSchema>;
export const customerReturnCustomerProfileEvidenceSchema = z.object({
  shopDomain: customerReturnShopSchema,
  externalCustomerId: customerReturnCustomerIdSchema,
  firstName: z.string().max(255).nullable(),
  lastName: z.string().max(255).nullable(),
  email: z.string().max(320).nullable(),
}).strict();
export type CustomerReturnCustomerProfileEvidence = z.infer<typeof customerReturnCustomerProfileEvidenceSchema>;
export interface CustomerReturnCustomerProfileReader {
  read(scope: CustomerReturnCustomerProfileScope): Promise<CustomerReturnCustomerProfileEvidence>;
}
export class CustomerReturnCustomerProfileError extends Error {
  readonly code = "RETURN_CUSTOMER_PROFILE_UNAVAILABLE";
  readonly status = 503;
  constructor() {
    super("Your account details are temporarily unavailable. Please try again.");
    this.name = "CustomerReturnCustomerProfileError";
  }
}

/** Identity must come from the verified session, never an order or request body. */
export class CustomerReturnCustomerProfileService {
  constructor(private readonly reader: CustomerReturnCustomerProfileReader) {}

  async read(principal: CustomerReturnCustomerSession): Promise<CustomerReturnCustomerProfile> {
    try {
      const scope = customerReturnCustomerProfileScopeSchema.parse({ channelId: principal.channelId,
        shopDomain: principal.shopDomain, externalCustomerId: principal.externalCustomerId });
      const evidence = customerReturnCustomerProfileEvidenceSchema.parse(await this.reader.read({ ...scope }));
      if (evidence.shopDomain !== scope.shopDomain || evidence.externalCustomerId !== scope.externalCustomerId) {
        throw new CustomerReturnCustomerProfileError();
      }
      const name = [evidence.firstName, evidence.lastName].map(part => part?.trim()).filter(Boolean).join(" ");
      return customerReturnCustomerProfileSchema.parse({ name: name || null, email: evidence.email?.trim() || null });
    } catch {
      // Provider errors can contain customer data, query text, or credentials.
      throw new CustomerReturnCustomerProfileError();
    }
  }
}
