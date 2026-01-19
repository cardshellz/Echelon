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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const usersApi = {
  getAll: async (): Promise<SafeUser[]> => {
    const res = await fetch("/api/users", { credentials: "include" });
    if (!res.ok) throw new Error("Failed to fetch users");
    return res.json();
  },
  create: async (data: { username: string; password: string; role: string; displayName: string }): Promise<SafeUser> => {
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to create user");
    }
    return res.json();
  },
  update: async (id: string, data: { displayName?: string; role?: string; password?: string; active?: number }): Promise<SafeUser> => {
    const res = await fetch(`/api/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to update user");
    }
    return res.json();
  },
};

export default function Users() {
  const queryClient = useQueryClient();
  
  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: usersApi.getAll,
  });
  
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState("picker");
  const [error, setError] = useState("");
  
  // Edit state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<SafeUser | null>(null);
  const [editDisplayName, setEditDisplayName] = useState("");
  const [editRole, setEditRole] = useState("");
  const [editPassword, setEditPassword] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editError, setEditError] = useState("");
  
  const createMutation = useMutation({
    mutationFn: usersApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setAddDialogOpen(false);
      resetForm();
    },
    onError: (err: Error) => {
      setError(err.message);
    },
  });
  
  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { displayName?: string; role?: string; password?: string; active?: number } }) => 
      usersApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setEditDialogOpen(false);
      resetEditForm();
    },
    onError: (err: Error) => {
      setEditError(err.message);
    },
  });
  
  const resetForm = () => {
    setNewUsername("");
    setNewPassword("");
    setNewDisplayName("");
    setNewRole("picker");
    setError("");
  };
  
  const resetEditForm = () => {
    setEditingUser(null);
    setEditDisplayName("");
    setEditRole("");
    setEditPassword("");
    setEditActive(true);
    setEditError("");
  };
  
  const openEditDialog = (user: SafeUser) => {
    setEditingUser(user);
    setEditDisplayName(user.displayName || "");
    setEditRole(user.role);
    setEditActive(user.active === 1);
    setEditPassword("");
    setEditError("");
    setEditDialogOpen(true);
  };
  
  const handleUpdate = () => {
    if (!editingUser) return;
    setEditError("");
    
    const data: { displayName?: string; role?: string; password?: string; active?: number } = {
      displayName: editDisplayName.trim() || editingUser.username,
      role: editRole,
      active: editActive ? 1 : 0,
    };
    
    if (editPassword.trim()) {
      data.password = editPassword;
    }
    
    updateMutation.mutate({ id: editingUser.id, data });
  };
  
  const handleCreate = () => {
    setError("");
    if (!newUsername.trim() || !newPassword.trim()) {
      setError("Username and password are required");
      return;
    }
    createMutation.mutate({
      username: newUsername.trim(),
      password: newPassword,
      role: newRole,
      displayName: newDisplayName.trim() || newUsername.trim(),
    });
  };
  
  const getRoleBadge = (role: string) => {
    switch (role) {
      case "admin":
        return <Badge className="bg-purple-100 text-purple-700 border-purple-200">Admin</Badge>;
      case "lead":
        return <Badge className="bg-blue-100 text-blue-700 border-blue-200">Lead</Badge>;
      default:
        return <Badge variant="outline">Picker</Badge>;
    }
  };
  
  const getRoleIcon = (role: string) => {
    switch (role) {
      case "admin":
        return <Shield className="h-4 w-4 text-purple-500" />;
      case "lead":
        return <UsersIcon className="h-4 w-4 text-blue-500" />;
      default:
        return <User className="h-4 w-4 text-muted-foreground" />;
    }
  };
  
  const pickers = users.filter(u => u.role === "picker");
  const leads = users.filter(u => u.role === "lead");
  const admins = users.filter(u => u.role === "admin");

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UsersIcon className="h-6 w-6" />
            User Management
          </h1>
          <p className="text-muted-foreground text-sm">
            Create and manage picker accounts
          </p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)} data-testid="button-add-user">
          <Plus className="h-4 w-4 mr-2" />
          Add User
        </Button>
      </div>
      
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pickers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pickers.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Leads</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{leads.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Admins</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{admins.length}</div>
          </CardContent>
        </Card>
      </div>
      
      <Card>
        <CardHeader>
          <CardTitle>All Users</CardTitle>
          <CardDescription>{users.length} total accounts</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
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
                          {getRoleIcon(user.role)}
                        </div>
                        <div>
                          <div className="font-medium">{user.displayName || user.username}</div>
                          <div className="text-xs text-muted-foreground">@{user.username}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>{getRoleBadge(user.role)}</TableCell>
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
                      <Button 
                        variant="ghost" 
                        size="sm"
                        onClick={() => openEditDialog(user)}
                        data-testid={`button-edit-user-${user.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      
      <Dialog open={addDialogOpen} onOpenChange={(open) => { setAddDialogOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5" />
              Create New User
            </DialogTitle>
            <DialogDescription>
              Add a new picker, lead, or admin account
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                {error}
              </div>
            )}
            
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                placeholder="e.g., picker2"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                data-testid="input-username"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="Enter password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                data-testid="input-password"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="displayName">Display Name</Label>
              <Input
                id="displayName"
                placeholder="e.g., John Smith"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                data-testid="input-displayname"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="role">Role</Label>
              <Select value={newRole} onValueChange={setNewRole}>
                <SelectTrigger data-testid="select-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="picker">Picker - Can only pick orders</SelectItem>
                  <SelectItem value="lead">Lead - Full ops access</SelectItem>
                  <SelectItem value="admin">Admin - Full access + integrations</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddDialogOpen(false); resetForm(); }}>
              Cancel
            </Button>
            <Button 
              onClick={handleCreate} 
              disabled={createMutation.isPending}
              data-testid="button-create-user"
            >
              {createMutation.isPending ? "Creating..." : "Create User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      <Dialog open={editDialogOpen} onOpenChange={(open) => { setEditDialogOpen(open); if (!open) resetEditForm(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5" />
              Edit User
            </DialogTitle>
            <DialogDescription>
              Update user details for @{editingUser?.username}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            {editError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                {editError}
              </div>
            )}
            
            <div className="space-y-2">
              <Label htmlFor="edit-displayName">Display Name</Label>
              <Input
                id="edit-displayName"
                placeholder="e.g., John Smith"
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
                data-testid="input-edit-displayname"
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="edit-role">Role</Label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger data-testid="select-edit-role">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="picker">Picker - Can only pick orders</SelectItem>
                  <SelectItem value="lead">Lead - Full ops access</SelectItem>
                  <SelectItem value="admin">Admin - Full access + integrations</SelectItem>
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="edit-password">New Password (leave blank to keep current)</Label>
              <Input
                id="edit-password"
                type="password"
                placeholder="Enter new password"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                data-testid="input-edit-password"
              />
            </div>
            
            <div className="flex items-center justify-between">
              <Label htmlFor="edit-active">Account Status</Label>
              <div className="flex items-center gap-2">
                <span className={cn("text-sm", editActive ? "text-green-600" : "text-red-600")}>
                  {editActive ? "Active" : "Inactive"}
                </span>
                <Button
                  type="button"
                  variant={editActive ? "default" : "destructive"}
                  size="sm"
                  onClick={() => setEditActive(!editActive)}
                  data-testid="button-toggle-active"
                >
                  {editActive ? "Deactivate" : "Activate"}
                </Button>
              </div>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEditDialogOpen(false); resetEditForm(); }}>
              Cancel
            </Button>
            <Button 
              onClick={handleUpdate} 
              disabled={updateMutation.isPending}
              data-testid="button-save-user"
            >
              {updateMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
