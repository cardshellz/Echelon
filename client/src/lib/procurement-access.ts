/** Navigation access for receipt readers and operators. Mutation authority stays
 * with each API and the matching action grant; a legacy role name grants none. */
export const RECEIVING_READ_PERMISSIONS = [
  { resource: "inventory", action: "view" },
  { resource: "inventory", action: "adjust" },
  { resource: "purchasing", action: "view" },
];

/** The connected procurement and AP read APIs share this grant. */
export const PURCHASING_READ_PERMISSION = { resource: "purchasing", action: "view" };

/** This dashboard combines inventory diagnostics and procurement financial reads. */
export const PURCHASING_DASHBOARD_READ_PERMISSIONS = [
  PURCHASING_READ_PERMISSION,
  { resource: "inventory", action: "view" },
];
