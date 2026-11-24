import { z } from "zod";
import { SHIPMENT_SCAN_PAGE_SIZE } from "@shared/procurement/shipment-work-list";

export const shipmentCostReadPageSchema = z.array(z.number().int().positive().safe()).max(SHIPMENT_SCAN_PAGE_SIZE);

/** Validate the entire request before SQL, then retain each identity once. */
export function shipmentCostReadBatches(shipmentIds: readonly number[]): number[][] {
  const ids = [...new Set(z.array(z.number().int().positive().safe()).parse(shipmentIds))];
  const pages: number[][] = [];
  for (let offset = 0; offset < ids.length; offset += SHIPMENT_SCAN_PAGE_SIZE) pages.push(ids.slice(offset, offset + SHIPMENT_SCAN_PAGE_SIZE));
  return pages;
}
