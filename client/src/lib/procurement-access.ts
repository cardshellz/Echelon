/** Navigation access for receipt readers and operators. Mutation authority stays
 * with each API and the matching action grant; a legacy role name grants none. */
export const RECEIVING_READ_PERMISSIONS = [
  { resource: "inventory", action: "view" },
  { resource: "inventory", action: "adjust" },
  { resource: "purchasing", action: "view" },
];

/** The connected PO, shipment and invoice read APIs share this grant. */
export const PURCHASING_READ_PERMISSION = { resource: "purchasing", action: "view" };
