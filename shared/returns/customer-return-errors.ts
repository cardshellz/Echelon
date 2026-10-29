/** Public, allowlisted guidance. Never render provider exceptions or stored PII. */
export function customerReturnRejectionMessage(
  code: string | null | undefined,
): string {
  switch (code) {
    case "RETURN_RATE_COST_LIMIT":
      return "Prepaid shipping could not be approved for this box. Use a smaller box, split the items, or contact us for help. No return or label was created.";
    case "RETURN_LABEL_ORIGIN_UNVERIFIED":
      return "The return shipping address needs verification. Contact us for help. No return or label was created.";
    case "RETURN_LABEL_ALLOCATION_UNVERIFIED":
      return "We need to verify the original shipment's item records before creating this return. Contact us for help. No return or label was created.";
    case "RETURN_LIVE_REVIEW_CHANGED":
    case "RETURN_INTAKE_SOURCE_CHANGED":
    case "RETURN_AUTHORIZATION_QUANTITY_EXCEEDED":
    case "RETURN_AUTHORIZATION_SOURCE_CONFLICT":
      return "The available return quantities changed. Choose the order again and review the remaining items. No new return or label was created.";
    case "RETURN_LABEL_BOX_PLAN_INVALID":
      return "The items in your boxes do not match the return quantities. Choose the order again and check each box. No return or label was created.";
    case "RETURN_INTAKE_WINDOW_ELAPSED":
      return "The return window has ended. Contact us for help. No return or label was created.";
    case "RETURN_LABEL_SETTINGS_CHANGED":
    case "RETURN_LABEL_SETTINGS_DISABLED":
      return "Prepaid return shipping changed or is paused. Choose the order again, or contact us for help. No return or label was created.";
    default:
      return "This return could not be created. Choose the order again to review its availability, or contact us for help.";
  }
}
