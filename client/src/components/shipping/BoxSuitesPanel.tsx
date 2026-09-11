import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  postJson,
  putJson,
  invalidateShippingAdmin,
} from "./pricing-programs/api";
import type { BoxSuiteSummary } from "@shared/shipping/configuration";
import { ConfigurationHistory } from "./ConfigurationHistory";
import { CatalogBoxPicker } from "./CatalogBoxPicker";
import { useChannelPackagingOverview } from "./ChannelPackagingPanel";
import {
  channelLabels,
  packagingAssignmentUrl,
  useConfigurationCommand,
  usePackagingConfiguration,
} from "./configuration-client";
export { useConfigurationCommand } from "./configuration-client";

export function BoxSuitesPanel() {
  const client = useQueryClient();
  const query = usePackagingConfiguration();
  const catalog = useChannelPackagingOverview();
  const [editing, setEditing] = useState<BoxSuiteSummary | null>();
  const [statusTarget, setStatusTarget] = useState<BoxSuiteSummary | null>(
    null,
  );
  const [name, setName] = useState("");
  const [boxIds, setBoxIds] = useState<number[]>([]);
  const [suiteSearch, setSuiteSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const commandFor = useConfigurationCommand();
  const data = query.data;
  async function save(task: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
      invalidateShippingAdmin(client);
      await query.refetch({ throwOnError: true });
      setEditing(undefined);
      setStatusTarget(null);
      setMessage(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save packaging.");
    } finally {
      setBusy(false);
    }
  }
  if (query.isLoading) return <p>Loading box suites…</p>;
  if (!data)
    return (
      <p role="alert">
        Unable to load box suites.{" "}
        <Button onClick={() => query.refetch()}>Retry</Button>
      </p>
    );
  const open = (value: BoxSuiteSummary | null, duplicate = false) => {
    setEditing(duplicate ? null : value);
    setName(
      duplicate && value
        ? `${value.name.slice(0, 150)} copy`
        : (value?.name ?? ""),
    );
    setBoxIds(value?.boxIds ?? []);
    setError("");
    setMessage("");
  };
  const affected = editing
    ? [
        ...data.assignments.filter((a) => a.suiteId === editing.id),
        ...(data.configurationAssignments ?? []).filter(
          (a) => a.suiteId === editing.id,
        ),
      ]
    : [];
  const suites = data.suites.filter(
    (s) =>
      Boolean(s.archived) === showArchived &&
      s.name.toLowerCase().includes(suiteSearch.toLowerCase()),
  );
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Box suites</h2>
          <p className="text-sm text-muted-foreground">
            Group existing boxes and mailers into reusable packaging choices.
            Fulfillment programs choose these suites as defaults or warehouse
            exceptions. Suite membership does not change physical warehouse
            availability or a box's branding.
          </p>
          <a className="text-sm underline" href="/shipping-settings?tab=boxes">
            Manage individual boxes in Box catalog
          </a>
        </div>
        <Button onClick={() => open(null)}>New suite</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          className="max-w-sm"
          aria-label="Search suites"
          placeholder="Search suites"
          value={suiteSearch}
          onChange={(e) => setSuiteSearch(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived suites
        </label>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-emerald-700">
          {message}
        </p>
      )}
      <div className="max-h-[32rem] overflow-auto divide-y rounded border">
        {!suites.length && (
          <p className="p-4 text-sm text-muted-foreground">
            No {showArchived ? "archived " : ""}suites match.
          </p>
        )}
        {suites.map((s) => {
          const usages = data.assignments.filter((a) => a.suiteId === s.id);
          const concreteUsages = (data.configurationAssignments ?? []).filter(
            (a) => a.suiteId === s.id,
          );
          return (
            <article
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 p-3"
            >
              <div className="min-w-0">
                <h3 className="font-medium">{s.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {s.boxIds.length} packaging{" "}
                  {s.boxIds.length === 1 ? "type" : "types"} ·{" "}
                  {s.archived ? "Archived" : "Active"}
                </p>
                {s.imported && (
                  <p className="text-xs text-muted-foreground">
                    Imported from your previous packaging configuration. You can
                    rename or edit it.
                  </p>
                )}
                <div className="flex flex-wrap gap-x-3 text-xs">
                  <span className="text-muted-foreground">Used by:</span>
                  {concreteUsages.slice(0, 3).map((a) => (
                    <a
                      key={`${a.channelId}:${a.warehouseId}`}
                      className="underline"
                      href={`/shipping-settings?tab=channel-routing&section=packaging&channelId=${a.channelId}`}
                    >
                      {a.channelName} ·{" "}
                      {a.warehouseId === null
                        ? "Default"
                        : data.warehouses.find((w) => w.id === a.warehouseId)
                            ?.name}
                    </a>
                  ))}
                  {concreteUsages.length > 3 && (
                    <a
                      className="underline"
                      href="/shipping-settings?tab=channel-routing&section=packaging"
                    >
                      +{concreteUsages.length - 3} more assignments
                    </a>
                  )}
                  {usages.length ? (
                    usages.slice(0, 2).map((a) => (
                      <a
                        key={`${a.channel}:${a.warehouseId}`}
                        className="underline"
                        href={packagingAssignmentUrl(a.channel)}
                      >
                        Legacy {channelLabels[a.channel]} ·{" "}
                        {a.warehouseId === null
                          ? "Default"
                          : (data.warehouses.find((w) => w.id === a.warehouseId)
                              ?.name ?? `Warehouse ${a.warehouseId}`)}
                      </a>
                    ))
                  ) : concreteUsages.length ? null : (
                    <span>Not assigned</span>
                  )}
                  {usages.length > 2 && (
                    <a
                      className="underline"
                      href="/shipping-settings?tab=channel-routing&section=packaging"
                    >
                      +{usages.length - 2} more assignments
                    </a>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {!s.archived && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => open(s)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => open(s, true)}
                    >
                      Duplicate
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setStatusTarget(s);
                    setError("");
                    setMessage("");
                  }}
                >
                  {s.archived ? "Restore" : "Archive"}
                </Button>
              </div>
            </article>
          );
        })}
      </div>
      <Dialog
        open={Boolean(statusTarget)}
        onOpenChange={(value) => {
          if (!value && !busy) setStatusTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {statusTarget?.archived ? "Restore" : "Archive"} suite
            </DialogTitle>
          </DialogHeader>
          {statusTarget && (
            <>
              <p>
                {statusTarget.archived
                  ? "Make this suite available for new assignments again."
                  : "Hide this suite from new assignments. Its history and previous shipments are preserved."}
              </p>
              <p className="font-medium">{statusTarget.name}</p>
              {!statusTarget.archived &&
              [
                ...data.assignments,
                ...(data.configurationAssignments ?? []),
              ].some((a) => a.suiteId === statusTarget.id) ? (
                <p role="alert">
                  This suite is still assigned. Use its “Used by” links to
                  reassign it before archiving.
                </p>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() => {
                    const body = {
                      id: statusTarget.id,
                      expectedRevision: statusTarget.revision,
                      archived: !statusTarget.archived,
                    };
                    void save(
                      () =>
                        putJson("/api/shipping/admin/box-suites/status", {
                          ...body,
                          commandId: commandFor(body),
                        }),
                      statusTarget.archived
                        ? "Suite restored."
                        : "Suite archived.",
                    );
                  }}
                >
                  {statusTarget.archived ? "Restore suite" : "Archive suite"}
                </Button>
              )}
              {error && (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setStatusTarget(null)}
              >
                Cancel
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={editing !== undefined}
        onOpenChange={(value) => {
          if (!value && !busy) setEditing(undefined);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit box suite" : "New box suite"}
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const body = {
                ...(editing ? { id: editing.id } : {}),
                name,
                boxIds: [...boxIds].sort((a, b) => a - b),
                expectedRevision: editing?.revision ?? 0,
              };
              void save(
                () =>
                  postJson("/api/shipping/admin/box-suites", {
                    ...body,
                    commandId: commandFor(body),
                  }),
                "Suite saved.",
              );
            }}
          >
            <label className="grid gap-1 text-sm">
              Suite name
              <Input
                required
                maxLength={160}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {catalog.data ? (
              <CatalogBoxPicker
                boxes={catalog.data.boxes}
                selected={boxIds}
                onChange={setBoxIds}
              />
            ) : (
              <p role="alert">
                {catalog.isLoading
                  ? "Loading catalog…"
                  : "Unable to load catalog."}
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => catalog.refetch()}
                >
                  Retry catalog
                </Button>
              </p>
            )}
            <p className="text-sm text-muted-foreground">
              {boxIds.length} packaging types selected.{" "}
              {affected.length
                ? `Saving affects ${affected.length} fulfillment-program ${affected.length === 1 ? "assignment" : "assignments"}.`
                : "Not assigned yet. Choose it in Fulfillment program packaging."}{" "}
              Previous shipment snapshots stay unchanged.
            </p>
            {editing && (
              <details>
                <summary className="cursor-pointer text-sm">
                  Change history
                </summary>
                <ConfigurationHistory resourceKey={`suite:${editing.id}`} />
              </details>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                disabled={
                  busy || !catalog.data || !boxIds.length || !name.trim()
                }
                type="submit"
              >
                Save suite
              </Button>
              <Button
                disabled={busy}
                variant="outline"
                type="button"
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
