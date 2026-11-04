import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessManagementRequestError, readAccessManagementFailure } from "./access-management-error";

// These existing management endpoints return numeric isSystem, unlike auth/me.
export const roleAssignmentListSchema = z.array(z.object({
  id: z.number().int().positive().safe(),
  name: z.string().min(1),
  isSystem: z.union([z.literal(0), z.literal(1)]),
})).refine(roles => new Set(roles.map(role => role.id)).size === roles.length, "Duplicate role IDs");
type AssignmentRole = z.infer<typeof roleAssignmentListSchema>[number];
type TargetUser = { id: string; username: string; displayName: string | null };
const assignedKey = (userId: string) => ["/api/users", userId, "roles"] as const;
// Keep the validated picker DTO out of the full role-editor response cache.
const availableKey = ["/api/roles", "assignment-options"] as const;

export async function readAssignmentRoles(url: string): Promise<AssignmentRole[]> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("Role data could not be verified.");
  return roleAssignmentListSchema.parse(await response.json());
}

export async function replaceUserRoleAssignments(userId: string, roleIds: number[]): Promise<void> {
  const ids = z.array(z.number().int().positive().safe()).refine(values => new Set(values).size === values.length).parse(roleIds);
  const response = await fetch(`/api/users/${encodeURIComponent(userId)}/roles`, {
    method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roleIds: ids }),
  });
  if (!response.ok) throw await readAccessManagementFailure(response, "The role update could not be confirmed.");
  z.object({ success: z.literal(true) }).parse(await response.json());
}

export function RoleAssignmentDialog({ user, onClose }: { user: TargetUser; onClose: () => void }) {
  const { hasPermission, refetch: refreshAccess } = useAuth();
  const queryClient = useQueryClient();
  const allowed = hasPermission("users", "view") && hasPermission("users", "manage_roles") && hasPermission("roles", "view");
  const assigned = useQuery({
    queryKey: assignedKey(user.id),
    queryFn: () => readAssignmentRoles(`/api/users/${encodeURIComponent(user.id)}/roles`),
    enabled: allowed, retry: false, staleTime: Infinity, refetchOnMount: "always", refetchOnWindowFocus: "always",
  });
  const available = useQuery({
    queryKey: availableKey, queryFn: () => readAssignmentRoles("/api/roles"),
    enabled: allowed, retry: false, staleTime: Infinity, refetchOnMount: "always", refetchOnWindowFocus: "always",
  });
  const [draft, setDraft] = useState<{ userId: string; ids: number[]; assigned: AssignmentRole[]; available: AssignmentRole[] } | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const mutation = useMutation({
    mutationFn: (ids: number[]) => replaceUserRoleAssignments(user.id, ids), retry: false,
    onSuccess: async () => {
      setDraft(null); setConfirmRemoval(false); setFailed(false);
      setNotice("Role assignments saved.");
      try {
        await queryClient.invalidateQueries({ queryKey: assignedKey(user.id), exact: true });
        await refreshAccess();
      } catch {
        setFailed(true);
        setNotice("Role assignments were saved, but access could not be refreshed. Reload before continuing.");
      }
    },
    onError: async (error: Error) => {
      // A lost response may follow a committed change. Read back authority;
      // neither replay the write nor claim that its previous state survived.
      setDraft(null); setConfirmRemoval(false); setFailed(true);
      setNotice(error instanceof AccessManagementRequestError && error.lastAccessManager
        ? error.message : "The role update could not be confirmed. Review the refreshed assignments before trying again.");
      try {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: assignedKey(user.id), exact: true }),
          queryClient.invalidateQueries({ queryKey: availableKey, exact: true }),
        ]);
        await refreshAccess();
      } catch {
        setNotice("The role update and current access could not be verified. Reload before trying again.");
      }
    },
  });
  const verified = allowed && assigned.isSuccess && available.isSuccess
    && !assigned.isFetching && !available.isFetching && !assigned.isError && !available.isError
    && !assigned.isStale && !available.isStale
    && roleAssignmentListSchema.safeParse(assigned.data).success && roleAssignmentListSchema.safeParse(available.data).success;
  const assignedRoles = verified ? assigned.data! : undefined;
  const availableRoles = verified ? available.data! : undefined;
  const unknownAssignment = assignedRoles?.some(role => !availableRoles?.some(option => option.id === role.id)) === true;
  const outdatedDraft = draft !== null && (draft.userId !== user.id || draft.assigned !== assigned.data || draft.available !== available.data);
  const editable = verified && !unknownAssignment && !outdatedDraft && !mutation.isPending;
  const selectedIds = draft?.ids ?? assignedRoles?.map(role => role.id);
  const changed = selectedIds !== undefined && assignedRoles !== undefined
    && (selectedIds.length !== assignedRoles.length || assignedRoles.some(role => !selectedIds.includes(role.id)));
  const removingAll = changed && selectedIds?.length === 0;
  const canSave = editable && changed && (!removingAll || confirmRemoval);
  const toggle = (roleId: number) => {
    if (!editable || !selectedIds || !assignedRoles || !availableRoles) return;
    setDraft({ userId: user.id, ids: selectedIds.includes(roleId) ? selectedIds.filter(id => id !== roleId) : [...selectedIds, roleId],
      assigned: assignedRoles, available: availableRoles });
    setConfirmRemoval(false); setNotice(null);
  };
  const reload = async () => {
    setDraft(null); setConfirmRemoval(false); setNotice(null); setFailed(false);
    try {
      const results = await Promise.all([assigned.refetch(), available.refetch()]);
      if (results.some(result => result.isError)) throw new Error("Role data unavailable");
    } catch {
      setFailed(true); setNotice("Role data could not be verified. Try reloading again.");
    }
  };

  return <Dialog open onOpenChange={open => { if (!open && !mutation.isPending) onClose(); }}>
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="role-assignment-dialog">
      <DialogHeader>
        <DialogTitle>Manage roles for {user.displayName || user.username}</DialogTitle>
        <DialogDescription>Choose the roles that grant this account access. Multiple roles may be assigned. Profile labels do not grant permissions.</DialogDescription>
      </DialogHeader>
      {!allowed ? <p role="alert">Viewing users, managing user roles, and viewing roles are required to edit assignments.</p>
        : !verified ? <p role="status" data-testid="role-assignment-unverified">{assigned.isError || available.isError ? "Role data could not be verified. Reload before editing." : "Loading verified role assignments…"}</p>
        : unknownAssignment ? <p role="alert">An assigned role is missing from the available role list. Reload or contact an administrator; no assignments can be changed here.</p>
        : outdatedDraft ? <p role="alert">Role data changed while you were editing. Reload to review current assignments.</p>
        : <div className="space-y-3" data-testid="role-assignment-options">
          {availableRoles!.map(role => <div className="flex items-center gap-3" key={role.id}>
            <Checkbox id={`assigned-role-${role.id}`} checked={selectedIds?.includes(role.id) === true} disabled={!editable}
              onCheckedChange={() => toggle(role.id)} data-testid={`checkbox-assigned-role-${role.id}`} />
            <Label htmlFor={`assigned-role-${role.id}`}>{role.name}{role.isSystem === 1 ? " (system)" : ""}</Label>
          </div>)}
          {availableRoles!.length === 0 && <p>No roles are available.</p>}
          {selectedIds?.length === 0 && <p>This account has no roles selected and will have no operational access.</p>}
        </div>}
      {removingAll && <div className="rounded border border-destructive p-3 space-y-2" data-testid="role-assignment-removal-warning">
        <p>Saving an empty selection removes all operational access for @{user.username}.</p>
        <div className="flex items-center gap-3"><Checkbox id="confirm-remove-all-roles" checked={confirmRemoval} disabled={!editable}
          onCheckedChange={checked => { if (editable) setConfirmRemoval(checked === true); }} data-testid="checkbox-confirm-remove-all-roles" />
          <Label htmlFor="confirm-remove-all-roles">I intend to remove every assigned role from this account.</Label></div>
      </div>}
      {notice && <p role={failed ? "alert" : "status"}>{notice}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={() => { void reload(); }} disabled={!allowed || mutation.isPending || assigned.isFetching || available.isFetching} data-testid="button-reload-assignments">Reload roles</Button>
        <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Close</Button>
        <Button onClick={() => { if (canSave && selectedIds) mutation.mutate(selectedIds); }} disabled={!canSave} data-testid="button-save-assignments">{mutation.isPending ? "Saving…" : "Save assignments"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
