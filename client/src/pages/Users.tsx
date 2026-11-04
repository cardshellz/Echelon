import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SafeUser } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";
import { 
  Users as UsersIcon, 
  Plus,
  Shield,
  User,
  Clock,
  CheckCircle,
  XCircle,
  Pencil
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/lib/auth";
import { RoleAssignmentDialog } from "@/components/identity/RoleAssignmentDialog";
import { AccessManagementRequestError, readAccessManagementFailure } from "@/components/identity/access-management-error";
import { z } from "zod";

type CreateUserInput = { username: string; password: string; displayName: string };
type UpdateUserInput = { displayName?: string; password?: string; active?: number };
const safeUserSchema = z.object({
  id: z.string().min(1), username: z.string(), role: z.string(), displayName: z.string().nullable(),
  active: z.union([z.literal(0), z.literal(1)]), createdAt: z.coerce.date(), lastLoginAt: z.coerce.date().nullable(),
});

export const usersApi = {
  getAll: async (): Promise<SafeUser[]> => {
    const res = await fetch("/api/users", { credentials: "include" });
    if (!res.ok) throw new Error("Failed to fetch users");
    return z.array(safeUserSchema).parse(await res.json());
  },
  create: async (data: CreateUserInput): Promise<SafeUser> => {
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ username: data.username, password: data.password, displayName: data.displayName }),
    });
    if (!res.ok) {
      throw new Error("The account creation could not be confirmed. Reload the user list before trying again.");
    }
    return safeUserSchema.parse(await res.json());
  },
  update: async (id: string, data: UpdateUserInput): Promise<SafeUser> => {
    const res = await fetch(`/api/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ displayName: data.displayName, password: data.password, active: data.active }),
    });
    if (!res.ok) {
      throw await readAccessManagementFailure(res, "The profile update could not be confirmed. Reload the user list before trying again.");
    }
    return safeUserSchema.parse(await res.json());
  },
};

export default function Users() {
  const queryClient = useQueryClient();
  const { hasPermission, refetch: refreshAccess } = useAuth();
  const canView = hasPermission("users", "view");
  const canCreate = hasPermission("users", "create");
  const canEdit = hasPermission("users", "edit");
  const canAssign = hasPermission("users", "manage_roles");
  const canReadRoles = hasPermission("roles", "view");
  
  const { data: users = [], isLoading, isError: usersError, refetch: reloadUsers } = useQuery({
    queryKey: ["users"],
    queryFn: usersApi.getAll,
    enabled: canView,
  });
  
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [error, setError] = useState("");
  
  // Edit state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<SafeUser | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editError, setEditError] = useState("");
  const [assignmentUser, setAssignmentUser] = useState<SafeUser | null>(null);
  
  const createMutation = useMutation({
    retry: false,
    mutationFn: usersApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setAddDialogOpen(false);
      resetForm();
    },
    onError: () => {
      setError("The account creation could not be confirmed. Reload the user list before trying again.");
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    },
  });
  
  const updateMutation = useMutation({
    retry: false,
    mutationFn: ({ id, data }: { id: string; data: UpdateUserInput }) =>
      usersApi.update(id, data),
    onSuccess: async () => {
      try {
        await queryClient.invalidateQueries({ queryKey: ["users"] });
        await refreshAccess();
        setEditDialogOpen(false);
        resetEditForm();
      } catch {
        setEditError("The profile was saved, but access could not be refreshed. Reload before continuing.");
      }
    },
    onError: async (error: Error) => {
      setEditError(error instanceof AccessManagementRequestError && error.lastAccessManager
        ? error.message : "The profile update could not be confirmed. Review the refreshed user list before trying again.");
      try {
        await queryClient.invalidateQueries({ queryKey: ["users"] });
        await refreshAccess();
      } catch {
        setEditError("The profile update and current access could not be verified. Reload before trying again.");
      }
    },
  });
  
  const resetForm = () => {
    setNewUsername("");
    setNewPassword("");
    setNewDisplayName("");
    setError("");
  };
  
  const resetEditForm = () => {
    setEditingUser(null);
    setEditDisplayName("");
    setEditPassword("");
    setEditActive(true);
    setEditError("");
  };
  
  const openEditDialog = (user: SafeUser) => {
    if (!canEdit || !canView) return;
    setEditingUser(user);
    setEditDisplayName(user.displayName || "");
    setEditActive(user.active === 1);
    setEditPassword("");
    setEditError("");
    setEditDialogOpen(true);
  };
  
  const handleUpdate = () => {
    if (!editingUser || !canView || !canEdit || updateMutation.isPending) return;
    setEditError("");
    
    const data: UpdateUserInput = {
      displayName: editDisplayName.trim() || editingUser.username,
      active: editActive ? 1 : 0,
    };
    
    if (editPassword.trim()) {
      data.password = editPassword;
    }
    
    updateMutation.mutate({ id: editingUser.id, data });
  };
  
  const handleCreate = () => {
    if (!canView || !canCreate || createMutation.isPending) return;
    setError("");
    if (!newUsername.trim() || !newPassword.trim()) {
      setError("Username and password are required");
      return;
    }
    createMutation.mutate({
      username: newUsername.trim(),
      password: newPassword,
      displayName: newDisplayName.trim() || newUsername.trim(),
    });
  };
  
  const activeUsers = users.filter(user => user.active === 1);
  const inactiveUsers = users.filter(user => user.active === 0);

  if (!canView) return <p role="alert" className="p-6">You do not have permission to view users.</p>;

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UsersIcon className="h-6 w-6" />
            User Management
          </h1>
          <p className="text-muted-foreground text-sm">
            Manage accounts and explicitly assigned access roles
          </p>
        </div>
        {canCreate && <Button onClick={() => setAddDialogOpen(true)} className="min-h-[44px] w-full sm:w-auto" data-testid="button-add-user">
          <Plus className="h-4 w-4 mr-2" />
          Add User
        </Button>}
      </div>
      
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total accounts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{users.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active accounts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeUsers.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Inactive accounts</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{inactiveUsers.length}</div>
          </CardContent>
        </Card>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>All Users</CardTitle>
          <CardDescription>{users.length} total accounts. Legacy labels below do not grant access; use Manage roles to review actual assignments.</CardDescription>
        </CardHeader>
        <CardContent>
          {usersError ? <div role="alert">Users could not be verified. <Button variant="outline" onClick={() => { void reloadUsers(); }}>Reload users</Button></div> : isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <>
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>User</TableHead>
                      <TableHead>Legacy label</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last Login</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="w-[80px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((user) => (
                      <TableRow key={user.id} data-testid={`row-user-${user.id}`}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                              <User className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div>
                              <div className="font-medium">{user.displayName || user.username}</div>
                              <div className="text-xs text-muted-foreground">@{user.username}</div>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell><Badge variant="outline" title="Compatibility label only; does not grant access">{user.role || "No label"}</Badge></TableCell>
                        <TableCell>
                          {user.active ? (
                            <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50">
                              <CheckCircle className="h-3 w-3 mr-1" />
                              Active
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50">
                              <XCircle className="h-3 w-3 mr-1" />
                              Inactive
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          {user.lastLoginAt ? (
                            <span className="text-sm text-muted-foreground flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatDistanceToNow(new Date(user.lastLoginAt), { addSuffix: true })}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">Never</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {formatDistanceToNow(new Date(user.createdAt), { addSuffix: true })}
                          </span>
                        </TableCell>
                        <TableCell>
                          {canEdit && <Button
                            variant="ghost" 
                            size="sm"
                            onClick={() => openEditDialog(user)}
                            data-testid={`button-edit-user-${user.id}`}
                            aria-label={`Edit profile for ${user.username}`}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>}
                          {canAssign && <Button variant="outline" size="sm" disabled={!canReadRoles} title={!canReadRoles ? "Viewing roles is also required" : undefined}
                            onClick={() => { if (canReadRoles) setAssignmentUser(user); }} data-testid={`button-manage-roles-${user.id}`}><Shield className="h-4 w-4 mr-1" />Manage roles</Button>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="md:hidden space-y-3">
                {users.map((user) => (
                  <div key={user.id} className="border rounded-lg p-4" data-testid={`card-user-${user.id}`}>
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                          <User className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div>
                          <div className="font-medium">{user.displayName || user.username}</div>
                          <div className="text-xs text-muted-foreground">@{user.username}</div>
                        </div>
                      </div>
                      {canEdit && <Button
                        variant="ghost" 
                        size="sm"
                        onClick={() => openEditDialog(user)}
                        data-testid={`button-edit-user-mobile-${user.id}`}
                        aria-label={`Edit profile for ${user.username}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      <Badge variant="outline" title="Compatibility label only; does not grant access">Legacy label: {user.role || "No label"}</Badge>
                      {user.active ? (
                        <Badge variant="outline" className="text-green-600 border-green-200 bg-green-50">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-red-600 border-red-200 bg-red-50">
                          <XCircle className="h-3 w-3 mr-1" />
                          Inactive
                        </Badge>
                      )}
                    </div>
                    {canAssign && <Button variant="outline" size="sm" className="mt-3" disabled={!canReadRoles} title={!canReadRoles ? "Viewing roles is also required" : undefined}
                      onClick={() => { if (canReadRoles) setAssignmentUser(user); }} data-testid={`button-manage-roles-mobile-${user.id}`}><Shield className="h-4 w-4 mr-1" />Manage roles</Button>}
                    <div className="text-xs text-muted-foreground mt-2">
                      {user.lastLoginAt ? (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          Last login {formatDistanceToNow(new Date(user.lastLoginAt), { addSuffix: true })}
                        </span>
                      ) : (
                        <span>Never logged in</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      
      <Dialog open={addDialogOpen} onOpenChange={(open) => { setAddDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Create New User
            </DialogTitle>
            <DialogDescription>
              Create an account without operational access. Assign roles separately after creation.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                {error}
              </div>
            )}
            
            <div className="space-y-2">
              <Label htmlFor="username" className="text-sm">Username</Label>
              <Input
                id="username"
                placeholder="e.g., picker2"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-username"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-password"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="displayName" className="text-sm">Display Name</Label>
              <Input
                id="displayName"
                placeholder="e.g., John Smith"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-displayname"
              />
            </div>
            
          </div>
          
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="min-h-[44px] w-full sm:w-auto" onClick={() => { setAddDialogOpen(false); resetForm(); }}>
              Cancel
            </Button>
            <Button 
              onClick={handleCreate} 
              disabled={!canCreate || createMutation.isPending}
              className="min-h-[44px] w-full sm:w-auto"
              data-testid="button-create-user"
            >
              {createMutation.isPending ? "Creating..." : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <Dialog open={editDialogOpen} onOpenChange={(open) => { setEditDialogOpen(open); if (!open) resetEditForm(); }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit User
            </DialogTitle>
            <DialogDescription>
              Update user details for @{editingUser?.username}. This form does not change assigned roles.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {editError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                {editError}
              </div>
            )}
            
            <div className="space-y-2">
              <Label htmlFor="edit-displayName" className="text-sm">Display Name</Label>
              <Input
                id="edit-displayName"
                placeholder="e.g., John Smith"
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-edit-displayname"
              />
            </div>
            
            
            <div className="space-y-2">
              <Label htmlFor="edit-password" className="text-sm">New Password (leave blank to keep current)</Label>
              <Input
                id="edit-password"
                type="password"
                placeholder="Enter new password"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                className="h-11"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-edit-password"
              />
            </div>
            
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-active" className="text-sm">Account Status</Label>
              <div className="flex items-center gap-2">
                <span className={cn("text-sm", editActive ? "text-green-600" : "text-red-600")}>
                  {editActive ? "Active" : "Inactive"}
                </span>
                <Button
                  type="button"
                  variant={editActive ? "default" : "destructive"}
                  size="sm"
                  className="min-h-[44px]"
                  onClick={() => setEditActive(!editActive)}
                  data-testid="button-toggle-active"
                >
                  {editActive ? "Deactivate" : "Activate"}
                </Button>
              </div>
            </div>
          </div>
          
          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="min-h-[44px] w-full sm:w-auto" onClick={() => { setEditDialogOpen(false); resetEditForm(); }}>
              Cancel
            </Button>
            <Button 
              onClick={handleUpdate} 
              disabled={!canEdit || updateMutation.isPending}
              className="min-h-[44px] w-full sm:w-auto"
              data-testid="button-save-user"
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {assignmentUser && <RoleAssignmentDialog key={assignmentUser.id} user={assignmentUser} onClose={() => setAssignmentUser(null)} />}
    </div>
  );
}
