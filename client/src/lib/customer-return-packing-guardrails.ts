import type { CustomerReturnFlowOrder } from "@shared/returns/customer-return-flow.contract";
import { MAX_RETURN_FLOW_PARCELS } from "@shared/returns/customer-return-flow.contract";
import { customerReturnPackingIssue } from "@shared/returns/customer-return-shipping-guardrails";
import { splitCustomerReturnItemsByWeight } from "@shared/returns/customer-return-weight-split";
import { initialPreviewParcelSize, previewParcelProductWeight, readPreviewParcelDimensions, readPreviewQuantity,
  type PreviewParcelDraft } from "./customer-return-parcels";

export function previewPackingGuardrailIssue(order: CustomerReturnFlowOrder, parcel: PreviewParcelDraft): "weight" | "size" | "unsupported" | null {
  const weight = previewParcelProductWeight(order, parcel);
  if (weight.status !== "ready" || order.packingLimits == null) return null;
  // Weight feedback does not wait for the customer to finish entering dimensions.
  if (!order.packingLimits.length) return "unsupported";
  if (order.packingLimits.every(limit => weight.weightGrams > limit.maxWeightGrams)) return "weight";
  try { return customerReturnPackingIssue(order.packingLimits, weight.weightGrams, readPreviewParcelDimensions(order, parcel).dimensions); }
  catch { return null; } // Incomplete dimension drafts are validated by the existing field/review boundary.
}

export function splitPreviewPackingBox(order: CustomerReturnFlowOrder, parcels: readonly PreviewParcelDraft[], sourceKey: number):
  | { ok: true; parcels: PreviewParcelDraft[] }
  | { ok: false; message: string } {
  const source = parcels.find(parcel => parcel.key === sourceKey);
  if (!source || !order.packingLimits?.length || parcels.some(parcel => !Number.isSafeInteger(parcel.key) || parcel.key <= 0))
    return { ok: false, message: "The box plan changed. Review your items again." };
  const items = source.items.flatMap(item => {
    const quantity = readPreviewQuantity(item.quantity);
    return quantity === 0 ? [] : [{ lineId: item.lineId, quantity: quantity ?? -1,
      unitWeightGrams: order.lines.find(line => line.id === item.lineId)?.unitWeightGrams ?? null }];
  });
  const result = splitCustomerReturnItemsByWeight(items, Math.max(...order.packingLimits.map(limit => limit.maxWeightGrams)),
    MAX_RETURN_FLOW_PARCELS - parcels.length + 1);
  if (!result.ok) return { ok: false, message: result.reason === "individual_item"
    ? "A single item needs a different shipping arrangement. Contact us for help with your return."
    : result.reason === "too_many_boxes" ? "This return needs more boxes than we can prepare online. Contact us for help."
    : "The item weights or quantities need verification. Contact us for help." };
  let nextKey = Math.max(...parcels.map(parcel => parcel.key));
  const replacements = result.boxes.map((box, index) => {
    const items = box.map(item => ({ lineId: item.lineId, quantity: String(item.quantity) }));
    return { key: index === 0 ? source.key : ++nextKey, items,
      size: index === 0 && source.size.kind === "custom" ? { ...source.size } : initialPreviewParcelSize(order, items) };
  });
  if (!Number.isSafeInteger(nextKey)) return { ok: false, message: "The box plan needs to be restarted. Choose your return items again." };
  return { ok: true, parcels: parcels.flatMap(parcel => parcel.key === sourceKey ? replacements : [parcel]) };
}
