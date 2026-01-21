import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Shield, Plus, Edit, Trash2, Users, Lock } from "lucide-react";

interface Role {
  id: number;
  name: string;
  description: string | null;
  isSystem: number;
  createdAt: string;
}

interface Permission {
  id: number;
  resource: string;
  action: string;
  description: string | null;
  category: string;
}

export default function Roles() {
  const { hasPermission } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleDescription, setNewRoleDescription] = useState("");
  const [selectedPermissions, setSelectedPermissions] = useState<number[]>([]);

  const canViewRoles = hasPermission("roles", "view");
  const canCreateRoles = hasPermission("roles", "create");
  const canEditRoles = hasPermission("roles", "edit");
  const canDeleteRoles = hasPermission("roles", "delete");

  const { data: roles = [], isLoading: rolesLoading } = useQuery<Role[]>({
    queryKey: ["/api/roles"],
    queryFn: async () => {
      const res = await fetch("/api/roles", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch roles");
      return res.json();
    },
    enabled: canViewRoles,
  });

  const { data: permissions = [] } = useQuery<Permission[]>({
    queryKey: ["/api/permissions"],
    queryFn: async () => {
      const res = await fetch("/api/permissions", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch permissions");
      return res.json();
    },
    enabled: canViewRoles,
  });

  const { data: rolePermissions = [] } = useQuery<Permission[]>({
    queryKey: ["/api/roles", selectedRole?.id, "permissions"],
    queryFn: async () => {
      if (!selectedRole) return [];
      const res = await fetch(`/api/roles/${selectedRole.id}/permissions`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch role permissions");
      return res.json();
    },
    enabled: !!selectedRole && canViewRoles,
  });

  const createRoleMutation = useMutation({
    mutationFn: async (data: { name: string; description: string; permissionIds: number[] }) => {
      const res = await fetch("/api/roles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create role");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      setIsCreateOpen(false);
      setNewRoleName("");
      setNewRoleDescription("");
      setSelectedPermissions([]);
      toast({ title: "Role created successfully" });
    },
  });

  const updatePermissionsMutation = useMutation({
    mutationFn: async (data: { roleId: number; permissionIds: number[] }) => {
      const res = await fetch(`/api/roles/${data.roleId}/permissions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ permissionIds: data.permissionIds }),
      });
      if (!res.ok) throw new Error("Failed to update permissions");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      toast({ title: "Permissions updated successfully" });
    },
  });

  const deleteRoleMutation = useMutation({
    mutationFn: async (roleId: number) => {
      const res = await fetch(`/api/roles/${roleId}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete role");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/roles"] });
      setSelectedRole(null);
      toast({ title: "Role deleted successfully" });
    },
    onError: (error: Error) => {
      toast({ title: error.message, variant: "destructive" });
    },
  });

  const groupedPermissions = permissions.reduce((acc, perm) => {
    if (!acc[perm.category]) acc[perm.category] = [];
    acc[perm.category].push(perm);
    return acc;
  }, {} as Record<string, Permission[]>);

  const rolePermissionIds = rolePermissions.map(p => p.id);

  const handlePermissionToggle = (permId: number) => {
    const newPermIds = rolePermissionIds.includes(permId)
      ? rolePermissionIds.filter(id => id !== permId)
      : [...rolePermissionIds, permId];
    
    if (selectedRole) {
      updatePermissionsMutation.mutate({ roleId: selectedRole.id, permissionIds: newPermIds });
    }
  };

  const handleCreatePermissionToggle = (permId: number) => {
    setSelectedPermissions(prev =>
      prev.includes(permId) ? prev.filter(id => id !== permId) : [...prev, permId]
    );
  };

  if (!canViewRoles) {
    return (
      <div className="flex items-center justify-center h-96" data-testid="page-roles-no-access">
        <Card className="p-6 text-center">
          <Lock className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold">Access Denied</h2>
          <p className="text-muted-foreground mt-2">You don't have permission to view roles.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="page-roles">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Roles & Permissions</h1>
          <p className="text-muted-foreground">Manage user roles and their access permissions</p>
        </div>
        {canCreateRoles && (
          <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-create-role">
                <Plus className="h-4 w-4 mr-2" />
                Create Role
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create New Role</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label htmlFor="role-name">Role Name</Label>
                  <Input
                    id="role-name"
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value)}
                    placeholder="e.g., Warehouse Manager"
                    data-testid="input-role-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="role-description">Description</Label>
                  <Input
                    id="role-description"
                    value={newRoleDescription}
                    onChange={(e) => setNewRoleDescription(e.target.value)}
                    placeholder="e.g., Full access to warehouse operations"
                    data-testid="input-role-description"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Permissions</Label>
                  <div className="border rounded-lg p-4 max-h-60 overflow-y-auto">
                    {Object.entries(groupedPermissions).map(([category, perms]) => (
                      <div key={category} className="mb-4">
                        <h4 className="font-medium capitalize mb-2">{category}</h4>
                        <div className="grid grid-cols-2 gap-2">
                          {perms.map(perm => (
                            <div key={perm.id} className="flex items-center space-x-2">
                              <Checkbox
                                id={`create-perm-${perm.id}`}
                                checked={selectedPermissions.includes(perm.id)}
                                onCheckedChange={() => handleCreatePermissionToggle(perm.id)}
                              />
                              <label htmlFor={`create-perm-${perm.id}`} className="text-sm capitalize">
                                {perm.action.replace(/_/g, ' ')}
                              </label>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <Button
                  onClick={() => createRoleMutation.mutate({
                    name: newRoleName,
                    description: newRoleDescription,
                    permissionIds: selectedPermissions,
                  })}
                  disabled={!newRoleName || createRoleMutation.isPending}
                  data-testid="button-submit-role"
                >
                  Create Role
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="md:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Roles
            </CardTitle>
          </CardHeader>
          <CardContent>
            {rolesLoading ? (
              <p className="text-muted-foreground">Loading roles...</p>
            ) : (
              <div className="space-y-2">
                {roles.map(role => (
                  <div
                    key={role.id}
                    onClick={() => setSelectedRole(role)}
                    className={`p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedRole?.id === role.id ? "border-primary bg-primary/5" : "hover:bg-muted"
                    }`}
                    data-testid={`role-item-${role.id}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{role.name}</span>
                      {role.isSystem === 1 && (
                        <Badge variant="secondary">System</Badge>
                      )}
                    </div>
                    {role.description && (
                      <p className="text-sm text-muted-foreground mt-1">{role.description}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span>
                {selectedRole ? `${selectedRole.name} Permissions` : "Select a Role"}
              </span>
              {selectedRole && selectedRole.isSystem === 0 && canDeleteRoles && (
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => deleteRoleMutation.mutate(selectedRole.id)}
                  data-testid="button-delete-role"
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  Delete
                </Button>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!selectedRole ? (
              <p className="text-muted-foreground text-center py-8">
                Select a role to view and edit its permissions
              </p>
            ) : (
              <Tabs defaultValue="dashboard">
                <TabsList className="mb-4 flex-wrap h-auto">
                  {Object.keys(groupedPermissions).map(category => (
                    <TabsTrigger key={category} value={category} className="capitalize">
                      {category}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {Object.entries(groupedPermissions).map(([category, perms]) => (
                  <TabsContent key={category} value={category}>
                    <div className="grid gap-3">
                      {perms.map(perm => (
                        <div
                          key={perm.id}
                          className="flex items-center justify-between p-3 border rounded-lg"
                        >
                          <div>
                            <div className="font-medium capitalize">
                              {perm.action.replace(/_/g, ' ')}
                            </div>
                            {perm.description && (
                              <p className="text-sm text-muted-foreground">{perm.description}</p>
                            )}
                          </div>
                          <Checkbox
                            checked={rolePermissionIds.includes(perm.id)}
                            onCheckedChange={() => handlePermissionToggle(perm.id)}
                            disabled={!canEditRoles || updatePermissionsMutation.isPending}
                            data-testid={`checkbox-perm-${perm.id}`}
                          />
                        </div>
                      ))}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
