import { z } from "zod";

/** Executable access contracts. Roles grant these; they never bypass dependencies.
 * Only migrated journeys live here. Unknown/legacy capabilities retain their
 * existing owner checks until explicitly reconciled, not inferred as complete.
 */
export const STAFF_CAPABILITIES = [
  { key: "users:reset_password", label: "Reset ordinary staff passwords", description: "Credential control for ordinary accounts. Requires fresh actor credentials; does not include access-control accounts.", category: "users", kind: "action", requires: [] },
  { key: "users:reset_privileged_password", label: "Reset privileged staff passwords", description: "Sensitive authority that can impersonate access-control holders and assigned system administrators/leads. Requires ordinary reset authority too.", category: "users", kind: "action", requires: ["users:reset_password"] },
  { key: "shipments:view", label: "View shipments", description: "Search shipment status and tracking. Does not grant order management or costs.", category: "shipping", kind: "view", requires: [] },
  { key: "shipments:view_costs", label: "View shipment carrier costs", description: "Sensitive carrier cost data on shipment reads.", category: "shipping", kind: "sensitive_data", requires: ["shipments:view"] },
  { key: "shipments:view_order_context", label: "View shipment order context", description: "Read a shipment's linked order summary, without order editing, prices or unrelated orders.", category: "shipping", kind: "view", requires: ["shipments:view"] },
] as const;
export type StaffCapability = typeof STAFF_CAPABILITIES[number]["key"];
export const SHIPMENT_CAPABILITIES = {
  view: "shipments:view", costs: "shipments:view_costs", orderContext: "shipments:view_order_context",
} as const;
export const STAFF_WORKFLOWS = [
  { id: "reset-staff-password", label: "Reset staff passwords", path: "/users", required: ["users:view", "users:reset_password"], optional: ["users:reset_privileged_password"] },
  { id: "shipment-tracking", label: "Shipment tracking", path: "/outbound-shipments", required: ["shipments:view"], optional: ["shipments:view_costs", "shipments:view_order_context"] },
  { id: "shipment-order-context", label: "Shipment to order summary", path: "/outbound-shipments/:id/order", required: ["shipments:view", "shipments:view_order_context"], optional: [] },
  { id: "assign-staff-access", label: "Assign staff access", path: "/users", required: ["users:view", "users:manage_roles", "roles:view"], optional: [] },
  { id: "edit-role-access", label: "Edit role access", path: "/roles", required: ["roles:view", "roles:edit"], optional: [] },
] as const;

export function hasStaffCapability(permissions: readonly string[], key: string): boolean {
  function allows(candidate: string, path: readonly string[]): boolean {
    if (!permissions.includes(candidate) || path.includes(candidate)) return false;
    const definition = STAFF_CAPABILITIES.find(item => item.key === candidate);
    return !definition || definition.requires.every(required => allows(required,[...path,candidate]));
  }
  return allows(key,[]);
}
export function staffCapabilityLabel(key: string): string {
  return STAFF_CAPABILITIES.find(item => item.key === key)?.label ?? key.replaceAll("_"," ").replace(":"," — ");
}
export function effectiveStaffCapabilities(granted: readonly string[]): string[] {
  return [...new Set(granted)].filter(key => hasStaffCapability(granted,key)).sort();
}
export function missingCapabilityDependencies(permissions: readonly string[]) {
  return STAFF_CAPABILITIES.flatMap(definition => permissions.includes(definition.key)
    ? definition.requires.filter(required => !permissions.includes(required)).map(required => ({ capability: definition.key, required })) : []);
}
export function newCapabilityDependencyGaps(before: readonly string[], after: readonly string[]) {
  const existing = missingCapabilityDependencies(before);
  return missingCapabilityDependencies(after).filter(gap =>
    !existing.some(item => item.capability === gap.capability && item.required === gap.required));
}
export function describeStaffWorkflows(permissions: readonly string[]) {
  return STAFF_WORKFLOWS.map(workflow => ({
    ...workflow, available: workflow.required.every(key => hasStaffCapability(permissions, key)),
    missing: workflow.required.filter(key => !hasStaffCapability(permissions, key)),
  }));
}
export const accessRevisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const effectiveStaffAccessSchema = z.object({
  userId: z.string(), label: z.string().optional(), active: z.boolean(),
  roleIds: z.array(z.number().int().positive()),
  permissions: z.array(z.string()), grantedPermissions: z.array(z.string()), restrictedPermissions: z.array(z.string()),
  sources: z.array(z.object({ permission: z.string(), roleId: z.number().int().positive(), roleName: z.string().optional(), restricted: z.boolean() })),
});
export type EffectiveStaffAccess = z.infer<typeof effectiveStaffAccessSchema>;
export const accessReviewSchema = z.object({
  revision: accessRevisionSchema, restricted: z.boolean(),
  permissionIds: z.array(z.number().int().positive()), roleIds: z.array(z.number().int().positive()),
  affectedCount: z.number().int().nonnegative(),
  users: z.array(z.object({ before: effectiveStaffAccessSchema, after: effectiveStaffAccessSchema })),
  dependencies: z.array(z.object({ userId: z.string(), capability: z.string(), required: z.string() })),
  blockingDependencies: z.array(z.object({ userId: z.string(), capability: z.string(), required: z.string() })),
  coverage: z.literal("migrated-workflows-only"),
});
export type AccessReview = z.infer<typeof accessReviewSchema>;
