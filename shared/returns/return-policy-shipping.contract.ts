import { z } from "zod";
import {
  customerReturnLabelSettingsFieldsSchema,
  customerReturnLabelSettingsStateSchema,
} from "./customer-return-label.contract";
import { refineCustomerReturnCarrierPolicy } from "./customer-return-carrier-policy";

/** Policy input has no settings version, owner ID or client-provided address.
 * The application validates the warehouse and freezes its destination snapshot. */
export const customerReturnPolicyShippingInputSchema =
  customerReturnLabelSettingsFieldsSchema.superRefine(
    refineCustomerReturnCarrierPolicy,
  );
export type CustomerReturnPolicyShippingInput = z.infer<
  typeof customerReturnPolicyShippingInputSchema
>;

export const returnPolicyShippingCatalogSchema =
  customerReturnLabelSettingsStateSchema
    .pick({
      providerConfigured: true,
      warehouses: true,
      carriers: true,
      message: true,
    })
    .strict();
export type ReturnPolicyShippingCatalog = z.infer<
  typeof returnPolicyShippingCatalogSchema
>;

export {
  customerReturnLabelControlSchema,
  customerReturnLabelControlInputSchema,
} from "./customer-return-label.contract";
