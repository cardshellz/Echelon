/** Preserve the existing pre-pick/address cutoff while explaining an unresolved
 * update. This is advisory; the existing address submission flow retains authority. */
export function orderAddressEligibility(input: {
  editEligible: boolean;
  editReasons: readonly string[];
  activeOperationId: string | null;
  activeOperationStatus?: string;
}): { editable: boolean; reasons: string[] } {
  if (input.activeOperationId)
    return {
      editable: false,
      reasons: [
        input.activeOperationStatus === "review_required"
          ? "Your previous order update needs review before you can change the shipping address. Contact us for help."
          : "Finish or cancel the existing order update before changing the shipping address.",
      ],
    };
  return { editable: input.editEligible, reasons: [...input.editReasons] };
}
