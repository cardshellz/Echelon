import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock3, Loader2, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type CommandStatus = "all" | "attention" | "claimed" | "succeeded" | "rejected" | "retryable" | "dead";

interface FinancialCommandSummary {
  total: number;
  claimed: number;
  succeeded: number;
  rejected: number;
  retryable: number;
  dead: number;
  stalledClaims: number;
  dueRetries: number;
  expiredNonterminal: number;
  oldestDeadAt: string | null;
  oldestStalledLeaseAt: string | null;
  oldestDueRetryAt: string | null;
}

interface FinancialCommandRow {
  id: number;
  actorType: string;
  actorId: string;
  method: string;
  routeTemplate: string;
  resourceKey: string;
  commandName: string;
  contractVersion: number;
  status: Exclude<CommandStatus, "all" | "attention">;
  attemptCount: number;
  attemptLimit: number;
  recoveryCount: number;
  leaseExpiresAt: string | null;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface FinancialCommandOperationsResponse {
  summary: FinancialCommandSummary;
  commands: FinancialCommandRow[];
  generatedAt: string;
}

export function FinancialCommandOperations({ canTriage }: { canTriage: boolean }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [status, setStatus] = useState<CommandStatus>("attention");
  const [search, setSearch] = useState("");
  const [rearmTarget, setRearmTarget] = useState<FinancialCommandRow | null>(null);
  const [reason, setReason] = useState("");
  const query = useQuery({
    queryKey: ["financial-command-operations", status, search.trim()],
    queryFn: () => fetchFinancialCommands(status, search.trim()),
    refetchInterval: 30_000,
  });

  const rearmMutation = useMutation({
    mutationFn: async (input: { commandId: number; reason: string }) => {
      const response = await apiRequest(
        "POST",
        `/api/operations/financial-commands/${input.commandId}/rearm`,
        { reason: input.reason },
      );
      return response.json() as Promise<{ message: string }>;
    },
    onSuccess: async (result) => {
      toast({ title: "One exact retry authorized", description: result.message });
      setRearmTarget(null);
      setReason("");
      await queryClient.invalidateQueries({ queryKey: ["financial-command-operations"] });
    },
  });

  const summary = query.data?.summary;
  const commands = query.data?.commands ?? [];

  return (
    <section className="mb-7">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Financial command ledger</h2>
            {summary && summary.dead === 0 && summary.stalledClaims === 0 && summary.dueRetries === 0 ? (
              <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
                <CheckCircle2 className="mr-1 h-3 w-3" /> Healthy
              </Badge>
            ) : summary ? (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">
                <AlertTriangle className="mr-1 h-3 w-3" /> Attention required
              </Badge>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Durable purchasing/AP commands, stalled leases, due retries, and audited dead-command recovery.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => query.refetch()} disabled={query.isFetching}>
          <RefreshCw className={cn("mr-2 h-4 w-4", query.isFetching && "animate-spin")} /> Refresh
        </Button>
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <SummaryCell label="Dead" value={summary?.dead} critical={Boolean(summary?.dead)} />
        <SummaryCell label="Stalled leases" value={summary?.stalledClaims} critical={Boolean(summary?.stalledClaims)} />
        <SummaryCell label="Due retries" value={summary?.dueRetries} critical={Boolean(summary?.dueRetries)} />
        <SummaryCell label="Terminal retained" value={(summary?.succeeded ?? 0) + (summary?.rejected ?? 0)} />
      </div>

      <div className="flex flex-wrap gap-2 border border-b-0 bg-muted/20 p-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search command, resource, or error code"
            className="pl-9"
          />
        </div>
        <Select value={status} onValueChange={(value) => setStatus(value as CommandStatus)}>
          <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="attention">Needs attention</SelectItem>
            <SelectItem value="dead">Dead</SelectItem>
            <SelectItem value="claimed">Claimed</SelectItem>
            <SelectItem value="retryable">Retryable</SelectItem>
            <SelectItem value="succeeded">Succeeded</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="overflow-x-auto border">
        <div className="grid min-w-[1050px] grid-cols-[100px_minmax(220px,1fr)_minmax(180px,1fr)_100px_150px_150px] gap-3 border-b bg-muted/30 px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
          <span>Status</span><span>Command</span><span>Resource</span><span>Attempts</span><span>Updated</span><span>Action</span>
        </div>
        {query.isLoading ? (
          <div className="flex items-center justify-center p-8 text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading ledger</div>
        ) : query.isError ? (
          <div className="p-6 text-sm text-red-700">{query.error instanceof Error ? query.error.message : "Financial command ledger failed to load"}</div>
        ) : commands.length === 0 ? (
          <div className="flex items-center gap-2 p-6 text-sm text-emerald-800"><CheckCircle2 className="h-5 w-5" /> No commands match this view.</div>
        ) : (
          <div className="min-w-[1050px] divide-y">
            {commands.map((command) => (
              <div key={command.id} className="grid grid-cols-[100px_minmax(220px,1fr)_minmax(180px,1fr)_100px_150px_150px] items-center gap-3 px-4 py-3 text-sm">
                <CommandStatusBadge status={command.status} />
                <div className="min-w-0">
                  <div className="truncate font-medium">{command.commandName}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">#{command.id} · v{command.contractVersion} · {command.method} {command.routeTemplate}</div>
                  {command.lastErrorCode && <div className="mt-1 truncate text-xs text-red-700">{command.lastErrorCode}: {command.lastErrorMessage}</div>}
                </div>
                <div className="min-w-0"><div className="truncate font-mono text-xs">{command.resourceKey}</div><div className="truncate text-xs text-muted-foreground">{command.actorType}:{command.actorId}</div></div>
                <div className="tabular-nums"><div>{command.attemptCount} / {command.attemptLimit}</div><div className="text-xs text-muted-foreground">{command.recoveryCount} recoveries</div></div>
                <div className="text-xs text-muted-foreground">{formatTimestamp(command.updatedAt)}{command.status === "retryable" && command.nextAttemptAt ? <div>Due {formatTimestamp(command.nextAttemptAt)}</div> : null}</div>
                <div>
                  {command.status === "dead" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canTriage}
                      title={canTriage ? "Authorize one exact caller retry" : "Requires operations:triage"}
                      onClick={() => setRearmTarget(command)}
                    >
                      <ShieldAlert className="mr-2 h-4 w-4" /> Re-arm once
                    </Button>
                  ) : command.status === "claimed" ? (
                    <span className="text-xs text-muted-foreground"><Clock3 className="mr-1 inline h-3 w-3" /> Lease {formatTimestamp(command.leaseExpiresAt)}</span>
                  ) : <span className="text-xs text-muted-foreground">No action</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={rearmTarget !== null} onOpenChange={(open) => !open && setRearmTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Authorize one exact retry?</DialogTitle>
            <DialogDescription>
              This does not reconstruct or run the request. It preserves the command identity and grants the originating caller one attempt to resend the same idempotency key and exact payload.
            </DialogDescription>
          </DialogHeader>
          {rearmTarget && (
            <div className="rounded border bg-muted/30 p-3 text-sm">
              <div className="font-medium">{rearmTarget.commandName} · command #{rearmTarget.id}</div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">{rearmTarget.resourceKey}</div>
              <div className="mt-2 text-xs text-red-700">{rearmTarget.lastErrorCode}: {rearmTarget.lastErrorMessage}</div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="financial-command-rearm-reason">Operator reason</Label>
            <Textarea
              id="financial-command-rearm-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={10}
              maxLength={1000}
              placeholder="Why is another exact attempt safe and necessary?"
            />
          </div>
          {rearmMutation.isError && (
            <div className="text-sm text-red-700">{rearmMutation.error instanceof Error ? rearmMutation.error.message : "Recovery failed"}</div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRearmTarget(null)}>Cancel</Button>
            <Button
              onClick={() => rearmTarget && rearmMutation.mutate({ commandId: rearmTarget.id, reason: reason.trim() })}
              disabled={!rearmTarget || reason.trim().length < 10 || rearmMutation.isPending}
            >
              {rearmMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Authorize one retry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SummaryCell({ label, value, critical = false }: { label: string; value?: number; critical?: boolean }) {
  return (
    <div className={cn("border p-3", critical && "border-amber-300 bg-amber-50")}>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value?.toLocaleString() ?? "—"}</div>
    </div>
  );
}

function CommandStatusBadge({ status }: { status: FinancialCommandRow["status"] }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "w-fit capitalize",
        status === "dead" && "border-red-300 bg-red-50 text-red-800",
        status === "retryable" && "border-amber-300 bg-amber-50 text-amber-800",
        status === "claimed" && "border-blue-300 bg-blue-50 text-blue-800",
        status === "succeeded" && "border-emerald-300 bg-emerald-50 text-emerald-800",
      )}
    >
      {status}
    </Badge>
  );
}

async function fetchFinancialCommands(status: CommandStatus, search: string): Promise<FinancialCommandOperationsResponse> {
  const query = new URLSearchParams({ status, limit: "50" });
  if (search) query.set("search", search);
  const response = await fetch(`/api/operations/financial-commands?${query.toString()}`, { credentials: "include" });
  const body = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(body?.error || `Financial command ledger failed with HTTP ${response.status}`);
  return body as FinancialCommandOperationsResponse;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
}
