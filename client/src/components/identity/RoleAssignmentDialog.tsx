import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AccessManagementRequestError, readAccessManagementFailure } from "./access-management-error";
import { accessReviewSchema, accessRevisionSchema, type AccessReview } from "@shared/staff-capabilities";
import { AccessReviewPanel } from "./AccessReviewPanel";

export const roleAssignmentListSchema = z.array(z.object({
  id: z.number().int().positive().safe(), name: z.string().min(1), isSystem: z.union([z.literal(0), z.literal(1)]),
})).refine(roles => new Set(roles.map(role => role.id)).size === roles.length, "Duplicate role IDs");
type TargetUser = { id: string; username: string; displayName: string | null };

export async function readAssignmentRoles(url: string) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("Role data could not be verified.");
  return roleAssignmentListSchema.parse(await response.json());
}
export async function replaceUserRoleAssignments(userId: string, roleIds: number[], expectedAccessRevision: string): Promise<void> {
  const ids = z.array(z.number().int().positive().safe()).refine(values => new Set(values).size === values.length).parse(roleIds);
  const response = await fetch(`/api/users/${encodeURIComponent(userId)}/roles`, {
    method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roleIds: ids, expectedAccessRevision: accessRevisionSchema.parse(expectedAccessRevision) }),
  });
  if (!response.ok) throw await readAccessManagementFailure(response, "The role update could not be confirmed.");
  z.object({ success: z.literal(true) }).parse(await response.json());
}

export function RoleAssignmentDialog({ user, onClose }: { user: TargetUser; onClose: () => void }) {
  const { hasPermission, refetch: refreshAccess } = useAuth();
  const queryClient = useQueryClient();
  const canRead = hasPermission("users", "view") && hasPermission("roles", "view");
  const canAssign = canRead && hasPermission("users", "manage_roles");
  const available = useQuery({
    queryKey: ["/api/roles", "assignment-options"], enabled: canRead, retry: false, staleTime: Infinity,
    refetchOnMount: "always", refetchOnWindowFocus: "always",
    queryFn: () => readAssignmentRoles("/api/roles"),
  });
  const snapshotKey = ["user-access-review",user.id];
  const snapshot = useQuery({
    queryKey: snapshotKey, enabled: canRead, retry: false, staleTime: Infinity,
    refetchOnMount: "always", refetchOnWindowFocus: "always",
    queryFn: async () => {
      const response = await fetch(`/api/users/${encodeURIComponent(user.id)}/access-review`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!response.ok) throw new Error("Current access could not be verified.");
      return accessReviewSchema.parse(await response.json());
    },
  });
  const [draft, setDraft] = useState<{ userId: string; ids: number[]; revision: string } | null>(null);
  const [reviewed, setReviewed] = useState<{ userId: string; ids: number[]; review: AccessReview } | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const reviewMutation = useMutation({
    retry: false,
    mutationFn: async (change: NonNullable<typeof draft>) => {
      const response = await fetch(`/api/users/${encodeURIComponent(change.userId)}/access-review`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roleIds: change.ids, expectedAccessRevision: change.revision }) });
      if (!response.ok) throw new Error("Access changed or could not be verified. Reload before editing.");
      return { userId: change.userId, ids: change.ids, review: accessReviewSchema.parse(await response.json()) };
    },
    onSuccess: setReviewed,
    onError: (error: Error) => { setReviewed(null); setFailed(true); setNotice(error.message); },
  });
  const mutation = useMutation({
    retry: false,
    mutationFn: (change: NonNullable<typeof reviewed>) => replaceUserRoleAssignments(change.userId, change.ids, change.review.revision),
    onSuccess: async () => {
      setDraft(null); setReviewed(null); setConfirmRemoval(false); setFailed(false);
      setNotice("Role assignments saved.");
      try { await queryClient.invalidateQueries({ queryKey: ["user-access-review"] }); await refreshAccess(); }
      catch { setFailed(true); setNotice("Assignments were saved, but access could not be refreshed. Reload before continuing."); }
    },
    onError: async (error: Error) => {
      // A lost response may follow a commit. Never replay or promise the old state.
      setDraft(null); setReviewed(null); setConfirmRemoval(false); setFailed(true);
      setNotice(error instanceof AccessManagementRequestError && error.lastAccessManager
        ? error.message : "The role update could not be confirmed. Reload and review current access before trying again.");
      await queryClient.invalidateQueries({ queryKey: ["user-access-review"] });
      await refreshAccess().catch(() => { setNotice("The update and current access could not be verified. Reload before trying again."); });
    },
  });
  const verified = canRead && snapshot.isSuccess && available.isSuccess && !snapshot.isFetching && !available.isFetching
    && !snapshot.isError && !available.isError && !snapshot.isStale && !available.isStale;
  const unknownRole = snapshot.data?.roleIds.some(id => !available.data?.some(role => role.id === id)) ?? false;
  const outdated = draft !== null && (draft.userId !== user.id || draft.revision !== snapshot.data?.revision);
  const pending = mutation.isPending || reviewMutation.isPending;
  const editable = canAssign && verified && !unknownRole && !outdated && !pending;
  const selected = draft?.userId === user.id ? draft.ids : snapshot.data?.roleIds ?? [];
  const removingAll = draft !== null && selected.length === 0;
  const changed = snapshot.data !== undefined && (selected.length !== snapshot.data.roleIds.length || selected.some(id => !snapshot.data!.roleIds.includes(id)));
  const canSave = editable && changed && (!removingAll || confirmRemoval);
  const reviewCurrent = reviewed !== null && reviewed.userId === user.id && reviewed.review.revision === snapshot.data?.revision;
  const reload = async () => {
    setDraft(null); setReviewed(null); setConfirmRemoval(false); setNotice(null);
    const results = await Promise.all([snapshot.refetch(),available.refetch()]);
    if (results.some(result => result.isError)) { setFailed(true); setNotice("Access could not be verified. Reload again before editing."); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose(); }}>
    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="role-assignment-dialog">
      <DialogHeader><DialogTitle>Access for {user.displayName || user.username}</DialogTitle>
        <DialogDescription>Roles combine their grants. Profile labels do not grant access. Review the resulting journeys before saving.</DialogDescription>
      </DialogHeader>
      {!verified ? <p role="status" data-testid="role-assignment-unverified">Current access could not be verified. Load users and roles before editing.</p>
        : unknownRole ? <p role="alert">An assigned role is unavailable. Reload before editing.</p>
        : outdated ? <p role="alert">Access changed while you were editing. Reload and review current access.</p>
        : <div className="space-y-2" data-testid="role-assignment-options">{available.data!.map(role => <div key={role.id} className="flex items-center gap-3">
          <Checkbox id={`assigned-role-${role.id}`} checked={selected.includes(role.id)} disabled={!editable}
            data-testid={`checkbox-assigned-role-${role.id}`} onCheckedChange={() => {
              if (!editable || !snapshot.data) return;
              setDraft({ userId: user.id, revision: draft?.revision ?? snapshot.data.revision,
                ids: selected.includes(role.id) ? selected.filter(id => id !== role.id) : [...selected,role.id] });
              setReviewed(null); setConfirmRemoval(false); setNotice(null);
            }} />
          <Label htmlFor={`assigned-role-${role.id}`}>{role.name}{role.isSystem ? " (system)" : ""}</Label>
        </div>)}</div>}
      {snapshot.data && <AccessReviewPanel review={reviewCurrent ? reviewed!.review : snapshot.data} />}
      {removingAll && <div data-testid="role-assignment-removal-warning"><p>Saving removes all operational access for this account.</p>
        <Checkbox id="confirm-remove-all-roles" checked={confirmRemoval} disabled={!editable}
          onCheckedChange={checked => setConfirmRemoval(checked === true)} data-testid="checkbox-confirm-remove-all-roles" />
        <Label htmlFor="confirm-remove-all-roles">I intend to remove every assigned role.</Label></div>}
      {notice && <p role={failed ? "alert" : "status"}>{notice}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={() => { void reload(); }} disabled={pending} data-testid="button-reload-assignments">Reload access</Button>
        <Button variant="outline" onClick={onClose} disabled={pending}>Close</Button>
        {!reviewCurrent ? <Button disabled={!canSave} data-testid="button-review-assignments" onClick={() => { if (canSave && draft) reviewMutation.mutate(draft); }}>Review access</Button>
          : <Button disabled={!canSave || reviewed!.review.blockingDependencies.length > 0} data-testid="button-save-assignments"
            onClick={() => { if (canSave && reviewed && reviewed.review.blockingDependencies.length === 0) mutation.mutate(reviewed); }}>Save reviewed assignments</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
