import { z } from "zod";
import type { CustomerReturnDimensions } from "../../../../shared/returns/customer-return-parcel";

/** These identities come from a verified local physical package, never a browser. */
export const customerReturnPackageDimensionsInputSchema = z.object({
  providerPhysicalShipmentId: z.string().regex(/^[1-9]\d*$/).max(16)
    .refine(value => Number.isSafeInteger(Number(value))),
  trackingNumber: z.string().min(1).max(200)
    .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)),
}).strict();

export type CustomerReturnPackageDimensionsInput = z.infer<typeof customerReturnPackageDimensionsInputSchema>;
export interface CustomerReturnPackageDimensionsReader {
  /** null means no usable original measurement, not a fabricated box size. */
  read(input: CustomerReturnPackageDimensionsInput, signal?: AbortSignal): Promise<CustomerReturnDimensions | null>;
}

export type CustomerReturnPackageDimensionsErrorCode =
  | "RETURN_PACKAGE_INPUT_INVALID" | "RETURN_PACKAGE_NOT_CONFIGURED" | "RETURN_PACKAGE_CONFIGURATION_INVALID"
  | "RETURN_PACKAGE_TRANSPORT_FAILED" | "RETURN_PACKAGE_TIMEOUT" | "RETURN_PACKAGE_CANCELLED" | "RETURN_PACKAGE_HTTP_REJECTED"
  | "RETURN_PACKAGE_RESPONSE_INVALID" | "RETURN_PACKAGE_RESPONSE_TOO_LARGE"
  | "RETURN_PACKAGE_LOOKUP_INCOMPLETE" | "RETURN_PACKAGE_NOT_FOUND" | "RETURN_PACKAGE_IDENTITY_MISMATCH";

/** No provider body, credential, tracking number, or raw cause crosses this boundary. */
export class CustomerReturnPackageDimensionsError extends Error {
  readonly status: number;
  constructor(readonly code: CustomerReturnPackageDimensionsErrorCode,
    readonly failureClass: "configuration" | "permanent" | "transient" = "permanent") {
    super("The original package dimensions could not be verified.");
    this.name = "CustomerReturnPackageDimensionsError";
    this.status = code === "RETURN_PACKAGE_INPUT_INVALID" ? 400 : 503;
  }
}
