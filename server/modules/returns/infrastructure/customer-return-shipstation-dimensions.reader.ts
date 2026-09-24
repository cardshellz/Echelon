import Decimal from "decimal.js";
import { z } from "zod";
import { customerReturnDimensionsSchema, type CustomerReturnDimensions } from "../../../../shared/returns/customer-return-parcel";
import { createShipStationLabelReconciliationClient } from "../../oms/shipstation-label-reconciliation.client";
import { LabelReconciliationError } from "../../oms/shipstation-label-reconciliation.service";
import type { ShipStationApiRequester } from "../../oms/shipstation-api-request";
import { readBoundedResponseText, ShipStationTrackingResponseReadError } from "../../shipping/shipstation-tracking-http";
import { CustomerReturnPackageDimensionsError, customerReturnPackageDimensionsInputSchema,
  type CustomerReturnPackageDimensionsReader } from "../application/customer-return-package-dimensions.ports";

const SHIPSTATION_V1_ORIGIN = "https://ssapi.shipstation.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const DimensionDecimal = Decimal.clone({ precision: 30 });
const credentialSchema = z.string().min(1).max(4096)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const shipmentMeasurementSchema = z.object({
  shipmentId: z.number().int().positive().safe(), trackingNumber: z.string().min(1).max(200),
  voided: z.boolean(), voidDate: z.string().max(200).nullish(), isReturnLabel: z.boolean(),
  dimensions: z.unknown().optional(),
});
// https://www.shipstation.com/docs/api/models/dimensions/ documents these two units.
const providerDimensionsSchema = z.object({
  units: z.enum(["inches", "centimeters"]),
  length: z.number().finite().positive(), width: z.number().finite().positive(), height: z.number().finite().positive(),
}).strict();

export interface CustomerReturnShipStationDimensionsDependencies {
  /** Server composition passes its V1 account credentials explicitly. No environment fallback. */
  apiKey?: string;
  apiSecret?: string;
  request?: typeof fetch;
}

/** Read-only: one bounded GET, no label observation, shipment reconciliation, or provider mutation. */
export function createCustomerReturnShipStationDimensionsReader(
  dependencies: CustomerReturnShipStationDimensionsDependencies,
): CustomerReturnPackageDimensionsReader {
  return {
    async read(raw, signal): Promise<CustomerReturnDimensions | null> {
      const parsed = customerReturnPackageDimensionsInputSchema.safeParse(raw);
      if (!parsed.success) throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_INPUT_INVALID");
      const input = parsed.data;
      if (signal?.aborted) throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_CANCELLED", "transient");
      const authorization = authentication(dependencies);
      const request = boundedRequester(dependencies.request ?? fetch, authorization, signal);
      const source = createShipStationLabelReconciliationClient(request, () => true);
      try {
        // V1 does not support shipmentId as a filter. Reuse the shipping owner's
        // complete tracking lookup and then select the immutable shipment ID.
        const rawShipment = await source.getLabel(Number(input.providerPhysicalShipmentId), input.trackingNumber);
        const result = shipmentMeasurementSchema.safeParse(rawShipment);
        if (!result.success) throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_RESPONSE_INVALID");
        const shipment = result.data;
        if (String(shipment.shipmentId) !== input.providerPhysicalShipmentId || shipment.trackingNumber !== input.trackingNumber) {
          throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_IDENTITY_MISMATCH");
        }
        if (shipment.voided || shipment.isReturnLabel || (shipment.voidDate !== null && shipment.voidDate !== undefined && shipment.voidDate !== "")) return null;
        if (shipment.dimensions === null || shipment.dimensions === undefined) return null;
        const dimensions = providerDimensionsSchema.safeParse(shipment.dimensions);
        if (!dimensions.success) throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_RESPONSE_INVALID");
        const factor = dimensions.data.units === "inches" ? "25.4" : "10";
        const convert = (value: number): number => new DimensionDecimal(value).times(factor).toNumber();
        const output = customerReturnDimensionsSchema.safeParse({ lengthMm: convert(dimensions.data.length),
          widthMm: convert(dimensions.data.width), heightMm: convert(dimensions.data.height) });
        if (!output.success) throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_RESPONSE_INVALID");
        return output.data;
      } catch (error) {
        if (error instanceof CustomerReturnPackageDimensionsError) throw error;
        if (error instanceof LabelReconciliationError) {
          throw new CustomerReturnPackageDimensionsError(error.code === "SHIPSTATION_LABEL_NOT_FOUND"
            ? "RETURN_PACKAGE_NOT_FOUND" : "RETURN_PACKAGE_LOOKUP_INCOMPLETE");
        }
        throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_RESPONSE_INVALID");
      }
    },
  };
}

function authentication(dependencies: CustomerReturnShipStationDimensionsDependencies): string {
  if (!dependencies.apiKey || !dependencies.apiSecret) {
    throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_NOT_CONFIGURED", "configuration");
  }
  if (!credentialSchema.safeParse(dependencies.apiKey).success || dependencies.apiKey.includes(":")
    || !credentialSchema.safeParse(dependencies.apiSecret).success) {
    throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_CONFIGURATION_INVALID", "configuration");
  }
  return `Basic ${Buffer.from(`${dependencies.apiKey}:${dependencies.apiSecret}`, "utf8").toString("base64")}`;
}

function boundedRequester(request: typeof fetch, authorization: string, parentSignal?: AbortSignal): ShipStationApiRequester {
  return async <T>(method: string, path: string): Promise<T> => {
    const url = new URL(path, SHIPSTATION_V1_ORIGIN);
    if (method !== "GET" || url.origin !== SHIPSTATION_V1_ORIGIN || url.pathname !== "/shipments") {
      throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_INPUT_INVALID");
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortFromParent: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      abortFromParent = () => {
        controller.abort();
        reject(new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_CANCELLED", "transient"));
      };
      parentSignal?.addEventListener("abort", abortFromParent, { once: true });
      if (parentSignal?.aborted) { abortFromParent(); return; }
      timer = setTimeout(() => {
        controller.abort();
        reject(new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_TIMEOUT", "transient"));
      }, REQUEST_TIMEOUT_MS);
    });
    const work = async (): Promise<T> => {
      if (controller.signal.aborted) throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_CANCELLED", "transient");
      let response: Response;
      try {
        response = await request(url, { method: "GET", headers: { Authorization: authorization, Accept: "application/json" },
          signal: controller.signal, redirect: "error", cache: "no-store" });
      } catch {
        throw new CustomerReturnPackageDimensionsError(parentSignal?.aborted ? "RETURN_PACKAGE_CANCELLED"
          : controller.signal.aborted ? "RETURN_PACKAGE_TIMEOUT" : "RETURN_PACKAGE_TRANSPORT_FAILED", "transient");
      }
      if (!response.ok) {
        // Never read/log an HTTP error body: it can contain provider PII or credentials.
        void response.body?.cancel().catch(() => undefined);
        const failureClass = response.status === 401 || response.status === 403 ? "configuration"
          : response.status === 429 || response.status >= 500 ? "transient" : "permanent";
        throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_HTTP_REJECTED", failureClass);
      }
      let responseText: string;
      try {
        responseText = await readBoundedResponseText(response, MAX_RESPONSE_BYTES);
      } catch (error) {
        if (controller.signal.aborted) throw new CustomerReturnPackageDimensionsError(parentSignal?.aborted
          ? "RETURN_PACKAGE_CANCELLED" : "RETURN_PACKAGE_TIMEOUT", "transient");
        if (error instanceof ShipStationTrackingResponseReadError) {
          throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_RESPONSE_TOO_LARGE");
        }
        throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_TRANSPORT_FAILED", "transient");
      }
      try { return JSON.parse(responseText) as T; }
      catch { throw new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_RESPONSE_INVALID"); }
    };
    try { return await Promise.race([work(), timeout]); }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortFromParent) parentSignal?.removeEventListener("abort", abortFromParent);
      // A declared oversized body can fail before consumption; release that
      // provider connection as well as cancelling requests that timed out.
      controller.abort();
    }
  };
}
