import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ShippingFulfillmentProviderConnection } from "@shared/types/shipping-fulfillment-routing";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  Link2,
  Loader2,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Route,
  ShieldCheck,
} from "lucide-react";
import {
  changeFulfillmentProviderConnectionStatus,
  createFulfillmentProviderConnection,
  FULFILLMENT_PROVIDER_CONNECTIONS_KEY,
  loadFulfillmentProviderConnections,
  replaceFulfillmentProviderCredential,
  verifyFulfillmentProviderConnection,
} from "./api";

interface ConnectionCommand {
  connection: ShippingFulfillmentProviderConnection;
  idempotencyKey: string;
}

export function FulfillmentProviderConnectionsTab() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const pendingKeys = useRef(new Map<string, string>());
  const [createOpen, setCreateOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [rotateConnection, setRotateConnection] = useState<ShippingFulfillmentProviderConnection | null>(null);
  const [replacementCredential, setReplacementCredential] = useState("");

  const query = useQuery({
    queryKey: [FULFILLMENT_PROVIDER_CONNECTIONS_KEY],
    queryFn: loadFulfillmentProviderConnections,
  });

  const refreshViews = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: [FULFILLMENT_PROVIDER_CONNECTIONS_KEY] }),
      queryClient.invalidateQueries({
        predicate: (candidate) => String(candidate.queryKey[0] ?? "")
          .includes("/fulfillment-routing"),
      }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: () => createFulfillmentProviderConnection({
      provider,
      name,
      credential,
      idempotencyKey: commandKey(pendingKeys.current, "create"),
    }),
    onSuccess: async () => {
      pendingKeys.current.delete("create");
      setCreateOpen(false);
      setName("");
      setCredential("");
      await refreshViews();
      toast({ title: "Fulfillment provider connected" });
    },
    onError: (error: Error) => toast({
      title: "Could not connect fulfillment provider",
      description: error.message,
      variant: "destructive",
    }),
  });

  const rotateMutation = useMutation({
    mutationFn: () => {
      if (!rotateConnection) throw new Error("Choose a provider connection.");
      const action = `credential:${rotateConnection.id}:${rotateConnection.revision}`;
      return replaceFulfillmentProviderCredential(rotateConnection.id, {
        credential: replacementCredential,
        expectedRevision: rotateConnection.revision,
        idempotencyKey: commandKey(pendingKeys.current, action),
      });
    },
    onSuccess: async () => {
      if (rotateConnection) pendingKeys.current.delete(
        `credential:${rotateConnection.id}:${rotateConnection.revision}`,
      );
      setRotateConnection(null);
      setReplacementCredential("");
      await refreshViews();
      toast({ title: "Provider credential replaced and verified" });
    },
    onError: (error: Error) => toast({
      title: "Could not replace provider credential",
      description: error.message,
      variant: "destructive",
    }),
  });

  const verifyMutation = useMutation({
    mutationFn: ({ connection, idempotencyKey }: ConnectionCommand) => (
      verifyFulfillmentProviderConnection(connection.id, {
        expectedRevision: connection.revision,
        idempotencyKey,
      })
    ),
    onSuccess: async (result, variables) => {
      pendingKeys.current.delete(commandSignature("verify", variables.connection));
      await refreshViews();
      toast({
        title: result.connection.status === "active"
          ? "Provider connection verified"
          : "Provider rejected the connection",
        description: result.connection.lastErrorMessage ?? undefined,
        variant: result.connection.status === "active" ? "default" : "destructive",
      });
    },
    onError: (error: Error) => toast({
      title: "Could not verify provider connection",
      description: error.message,
      variant: "destructive",
    }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ connection, enabled, idempotencyKey }: ConnectionCommand & { enabled: boolean }) => (
      changeFulfillmentProviderConnectionStatus(connection.id, enabled, {
        expectedRevision: connection.revision,
        idempotencyKey,
      })
    ),
    onSuccess: async (_result, variables) => {
      pendingKeys.current.delete(commandSignature(variables.enabled ? "enable" : "disable", variables.connection));
      await refreshViews();
      toast({ title: `Provider connection ${variables.enabled ? "enabled" : "disabled"}` });
    },
    onError: (error: Error) => toast({
      title: "Could not change provider connection",
      description: error.message,
      variant: "destructive",
    }),
  });

  if (query.isLoading) {
    return <div className="flex min-h-52 items-center justify-center rounded-md border">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>;
  }
  if (query.isError || !query.data) {
    return <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Provider connections could not be loaded</AlertTitle>
      <AlertDescription className="mt-2">
        <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" /> Retry
        </Button>
      </AlertDescription>
    </Alert>;
  }

  const managedProviders = query.data.providers.filter((item) => item.supportsManagedConnections);
  const selectedDescriptor = query.data.providers.find((item) => item.provider === provider);
  const busy = createMutation.isPending || rotateMutation.isPending
    || verifyMutation.isPending || statusMutation.isPending;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Fulfillment provider connections</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Connect label and carrier-service providers here. Service levels map to methods from these
            connections, so routing is independent of any one provider.
          </p>
        </div>
        <Button
          type="button"
          disabled={!query.data.credentialVaultConfigured || managedProviders.length === 0}
          onClick={() => {
            setProvider(managedProviders[0]?.provider ?? "");
            setCreateOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" /> Connect provider
        </Button>
      </header>

      {!query.data.credentialVaultConfigured && (
        <Alert>
          <KeyRound className="h-4 w-4" />
          <AlertTitle>Managed credential vault is not configured</AlertTitle>
          <AlertDescription>
            Existing deployment-managed connections can still run. Set
            {" "}<code>SHIPPING_PROVIDER_CREDENTIAL_ENCRYPTION_KEY</code> to add or rotate provider credentials here.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {query.data.connections.length === 0 ? (
          <div className="col-span-full rounded-md border border-dashed p-8 text-center">
            <Link2 className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-3 font-medium">No fulfillment providers connected</p>
            <p className="text-sm text-muted-foreground">Connect one before mapping service-level routing.</p>
          </div>
        ) : query.data.connections.map((connection) => (
          <Card key={connection.id}>
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle className="text-base">{connection.name}</CardTitle>
                  <CardDescription>{connection.providerDisplayName}</CardDescription>
                </div>
                <ConnectionStatusBadge connection={connection} />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Detail
                  icon={<ShieldCheck className="h-4 w-4" />}
                  label="Credential"
                  value={connection.credentialConfigured ? "Configured" : "Missing"}
                />
                <Detail
                  icon={<Route className="h-4 w-4" />}
                  label="Active routes"
                  value={String(connection.routedMethodCount)}
                />
                <Detail
                  label="Management"
                  value={connection.systemManaged ? "Deployment" : "Admin vault"}
                />
                <Detail label="Last verified" value={formatTimestamp(connection.lastVerifiedAt)} />
              </div>

              {connection.lastErrorMessage && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Connection needs attention</AlertTitle>
                  <AlertDescription>{connection.lastErrorMessage}</AlertDescription>
                </Alert>
              )}

              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || !connection.credentialConfigured || connection.status === "disabled"}
                  onClick={() => runConnectionCommand("verify", connection, pendingKeys.current, (command) => (
                    verifyMutation.mutate(command)
                  ))}
                >
                  {verifyMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <RefreshCw className="mr-2 h-4 w-4" />}
                  Verify
                </Button>
                {!connection.systemManaged && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || !query.data.credentialVaultConfigured}
                    onClick={() => {
                      setRotateConnection(connection);
                      setReplacementCredential("");
                    }}
                  >
                    <KeyRound className="mr-2 h-4 w-4" /> Replace key
                  </Button>
                )}
                {connection.status === "disabled" ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy || !connection.credentialConfigured}
                    onClick={() => runStatusCommand(true, connection, pendingKeys.current, statusMutation.mutate)}
                  >
                    <Power className="mr-2 h-4 w-4" /> Enable
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || connection.routedMethodCount > 0}
                    title={connection.routedMethodCount > 0
                      ? "Remove this connection from service-level routes before disabling it."
                      : "Disable provider connection"}
                    onClick={() => {
                      if (!window.confirm(`Disable ${connection.name}?`)) return;
                      runStatusCommand(false, connection, pendingKeys.current, statusMutation.mutate);
                    }}
                  >
                    <PowerOff className="mr-2 h-4 w-4" /> Disable
                  </Button>
                )}
              </div>
              {connection.routedMethodCount > 0 && connection.status !== "disabled" && (
                <p className="text-xs text-muted-foreground">
                  Remove its {connection.routedMethodCount} active method(s) from Service Levels before disabling it.
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => {
        if (createMutation.isPending) return;
        setCreateOpen(open);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect fulfillment provider</DialogTitle>
            <DialogDescription>
              The credential is verified before it is encrypted and stored. It is never shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="fulfillment-provider">Provider</Label>
              <Select value={provider} onValueChange={(value) => {
                pendingKeys.current.delete("create");
                setProvider(value);
              }}>
                <SelectTrigger id="fulfillment-provider"><SelectValue placeholder="Choose provider" /></SelectTrigger>
                <SelectContent>
                  {managedProviders.map((item) => (
                    <SelectItem key={item.provider} value={item.provider}>{item.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="fulfillment-provider-name">Connection name</Label>
              <Input
                id="fulfillment-provider-name"
                value={name}
                maxLength={160}
                placeholder="Primary ShipStation account"
                onChange={(event) => {
                  pendingKeys.current.delete("create");
                  setName(event.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fulfillment-provider-credential">
                {selectedDescriptor?.credentialLabel ?? "Provider credential"}
              </Label>
              <Input
                id="fulfillment-provider-credential"
                type="password"
                autoComplete="new-password"
                value={credential}
                maxLength={4_096}
                onChange={(event) => {
                  pendingKeys.current.delete("create");
                  setCredential(event.target.value);
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={createMutation.isPending} onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={createMutation.isPending || !provider || !name.trim() || !credential.trim()}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Verify and connect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rotateConnection !== null} onOpenChange={(open) => {
        if (!open && !rotateMutation.isPending) setRotateConnection(null);
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace provider credential</DialogTitle>
            <DialogDescription>
              The new credential is verified before it replaces the credential for {rotateConnection?.name}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="replacement-provider-credential">New API key</Label>
            <Input
              id="replacement-provider-credential"
              type="password"
              autoComplete="new-password"
              value={replacementCredential}
              maxLength={4_096}
              onChange={(event) => {
                if (rotateConnection) pendingKeys.current.delete(
                  `credential:${rotateConnection.id}:${rotateConnection.revision}`,
                );
                setReplacementCredential(event.target.value);
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={rotateMutation.isPending} onClick={() => setRotateConnection(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={rotateMutation.isPending || !replacementCredential.trim()}
              onClick={() => rotateMutation.mutate()}
            >
              {rotateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Verify and replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ConnectionStatusBadge({ connection }: { connection: ShippingFulfillmentProviderConnection }) {
  if (connection.status === "active" && connection.credentialConfigured) {
    return <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
      <CheckCircle2 className="mr-1 h-3 w-3" /> Active
    </Badge>;
  }
  if (connection.status === "disabled") return <Badge variant="secondary">Disabled</Badge>;
  return <Badge variant="destructive">Needs attention</Badge>;
}

function Detail({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return <div className="rounded-md border p-3">
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
    <p className="mt-1 font-medium">{value}</p>
  </div>;
}

function commandSignature(action: string, connection: ShippingFulfillmentProviderConnection): string {
  return `${action}:${connection.id}:${connection.revision}`;
}

function commandKey(keys: Map<string, string>, signature: string): string {
  const existing = keys.get(signature);
  if (existing) return existing;
  const created = `fulfillment-provider:${signature}:${crypto.randomUUID()}`;
  keys.set(signature, created);
  return created;
}

function runConnectionCommand(
  action: string,
  connection: ShippingFulfillmentProviderConnection,
  keys: Map<string, string>,
  run: (command: ConnectionCommand) => void,
): void {
  const signature = commandSignature(action, connection);
  run({ connection, idempotencyKey: commandKey(keys, signature) });
}

function runStatusCommand(
  enabled: boolean,
  connection: ShippingFulfillmentProviderConnection,
  keys: Map<string, string>,
  run: (command: ConnectionCommand & { enabled: boolean }) => void,
): void {
  const signature = commandSignature(enabled ? "enable" : "disable", connection);
  run({ connection, enabled, idempotencyKey: commandKey(keys, signature) });
}

function formatTimestamp(value: string | null): string {
  if (!value) return "Not yet";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString();
}
