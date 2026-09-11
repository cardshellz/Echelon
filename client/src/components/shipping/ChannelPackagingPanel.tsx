import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  packagingPolicyOverviewSchema,
  packagingRequirementSchema,
  type PackagingPolicyOverview,
  type ChannelPackagingPolicy,
} from "@shared/shipping/packaging-policy";
import {
  eligiblePackagingBoxes,
  packagingBrandingAllowed,
} from "@shared/shipping/packaging-eligibility";
import {
  getJson,
  putJson,
  invalidateShippingAdmin,
} from "./pricing-programs/api";
import { useConfigurationCommand } from "./configuration-client";

export function useChannelPackagingOverview(dropship = false) {
  const url = dropship
    ? "/api/dropship/admin/shipping/shared/packaging-policies"
    : "/api/shipping/admin/packaging-policies";
  return useQuery({
    queryKey: [url],
    queryFn: async () =>
      packagingPolicyOverviewSchema.parse(await getJson<unknown>(url)),
  });
}

export function ChannelPackagingPanel({
  dropship = false,
  renderPricing,
}: {
  dropship?: boolean;
  renderPricing?: (warehouseId: number | null) => ReactNode;
}) {
  const query = useChannelPackagingOverview(dropship);
  const [selectedId, setSelectedId] = useState(
    Number(new URLSearchParams(location.search).get("channelId")) || 0,
  );
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<{
    channelId: number;
    warehouseId: number | null;
  } | null>(null);
  const [message, setMessage] = useState("");
  const data = query.data;
  if (!data)
    return (
      <div role={query.isError ? "alert" : undefined}>
        {query.isLoading
          ? "Loading packaging configuration…"
          : "Unable to load packaging configuration."}{" "}
        <Button variant="outline" onClick={() => query.refetch()}>
          Refresh
        </Button>
      </div>
    );
  const channels = data.channels.filter(
    (c) =>
      c.status === "active" && (!dropship || c.legacyProfile === "dropship"),
  );
  const requestedLegacyProfile = new URLSearchParams(location.search).get(
    "profile",
  );
  const channel =
    channels.find((c) => c.id === selectedId) ??
    channels.find((c) => c.legacyProfile === requestedLegacyProfile) ??
    channels[0];
  if (!channel)
    return (
      <p role="alert">
        No active {dropship ? "Dropship OMS" : "fulfillment"} channel is
        configured. Configure the channel before assigning packaging.
      </p>
    );
  const policy = data.policies.find((p) => p.channelId === channel.id);
  const suiteName = (id?: number) =>
    data.suites.find((s) => s.id === id)?.name ?? "Not configured";
  const enabledWarehouseIds = new Set(
    data.warehouseAssignments
      .filter(
        (assignment) =>
          assignment.channelId === channel.id && assignment.enabled,
      )
      .map((assignment) => assignment.warehouseId),
  );
  const inactiveOverrides =
    policy?.overrides.filter(
      (override) => !enabledWarehouseIds.has(override.warehouseId),
    ) ?? [];
  const warehouses = data.warehouses.filter(
    (warehouse) =>
      enabledWarehouseIds.has(warehouse.id) &&
      warehouse.name.toLowerCase().includes(search.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(warehouses.length / 50));
  const currentPage = Math.min(page, pages - 1);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            Fulfillment program packaging
          </h2>
          <p className="text-sm text-muted-foreground">
            Set the program default, then add a suite exception only where an
            enabled warehouse needs different packaging.
          </p>
        </div>
        <Button variant="outline" onClick={() => query.refetch()}>
          Refresh assignments
        </Button>
      </div>
      <label className="grid max-w-md gap-1 text-sm">
        Fulfillment program
        <select
          aria-label="Fulfillment program"
          className="h-10 rounded border bg-background px-2"
          value={channel.id}
          onChange={(e) => {
            setSelectedId(Number(e.target.value));
            setPage(0);
            setMessage("");
          }}
        >
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.provider} · #{c.id}
            </option>
          ))}
        </select>
      </label>
      {enabledWarehouseIds.size === 0 && (
        <div
          role="status"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
        >
          {channel.name} has no explicitly enabled fulfillment warehouse.{" "}
          Enable the warehouse for this program in Channel Allocation before
          configuring its packaging.
        </div>
      )}
      {!policy && (
        <div
          role="status"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
        >
          Legacy packaging is still in use. Review box branding and warehouse
          availability in the catalog, then save this configuration. Nothing is
          changed automatically.
        </div>
      )}
      {inactiveOverrides.length > 0 && (
        <div
          role="status"
          className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
        >
          {inactiveOverrides.length} saved warehouse{" "}
          {inactiveOverrides.length === 1
            ? "exception references"
            : "exceptions reference"}{" "}
          a warehouse that is no longer enabled for {channel.name}. Saving the
          program default removes these stale exceptions.
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border p-4">
        <div>
          <h3 className="font-medium">Default packaging for {channel.name}</h3>
          <p>{suiteName(policy?.defaultSuiteId)}</p>
          <p className="text-xs text-muted-foreground">
            {policy
              ? `${policy.requirement === "unbranded" ? "White label only" : "Any branding"} · Revision ${policy.revision}`
              : "Needs review"}
            . A warehouse exception replaces this default.
          </p>
        </div>
        <Button
          variant="outline"
          disabled={!enabledWarehouseIds.size}
          onClick={() =>
            setEditing({ channelId: channel.id, warehouseId: null })
          }
        >
          {policy ? "Edit default" : "Configure packaging"}
        </Button>
        {renderPricing && (
          <div className="w-full border-t pt-3 text-sm">
            <div className="font-medium">Default pricing program</div>
            {renderPricing(null)}
          </div>
        )}
      </div>
      {message && (
        <p role="status" className="text-emerald-700">
          {message}
        </p>
      )}
      <div>
        <h3 className="font-medium">Enabled fulfillment warehouses</h3>
        <p className="text-sm text-muted-foreground">
          Only warehouses already enabled for {channel.name} appear here.
          Packaging settings never enable, disable, or prioritize warehouses.
        </p>
      </div>
      {enabledWarehouseIds.size > 0 && (
        <Input
          className="max-w-sm"
          aria-label="Search enabled warehouses"
          placeholder="Search enabled warehouses"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
      )}
      <div className="max-h-[30rem] overflow-auto rounded border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th className="p-3">Warehouse</th>
              {renderPricing && (
                <th className="p-3">Pricing program</th>
              )}
              <th className="p-3">Effective suite</th>
              <th className="p-3">Usable packaging</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {enabledWarehouseIds.size === 0 && (
              <tr>
                <td
                  className="p-6 text-center text-muted-foreground"
                  colSpan={renderPricing ? 5 : 4}
                >
                  No warehouse is explicitly enabled for this fulfillment
                  program. Enable at least one warehouse in Channel Allocation
                  before assigning packaging.
                </td>
              </tr>
            )}
            {enabledWarehouseIds.size > 0 && warehouses.length === 0 && (
              <tr>
                <td
                  className="p-6 text-center text-muted-foreground"
                  colSpan={renderPricing ? 5 : 4}
                >
                  No enabled warehouse matches the search.
                </td>
              </tr>
            )}
            {warehouses
              .slice(currentPage * 50, (currentPage + 1) * 50)
              .map((w) => {
                const override = policy?.overrides.find(
                  (o) => o.warehouseId === w.id,
                );
                const suite = data.suites.find(
                  (s) => s.id === (override?.suiteId ?? policy?.defaultSuiteId),
                );
                const available = eligiblePackagingBoxes(
                  data.boxes.filter((b) => suite?.boxIds.includes(b.id)),
                  w.id,
                  policy?.requirement ?? "any",
                );
                return (
                  <tr key={w.id} className="border-b align-top last:border-0">
                    <th scope="row" className="p-3 font-medium">
                      {w.name}
                      <div className="text-xs font-normal text-muted-foreground">
                        Enabled for fulfillment
                      </div>
                    </th>
                    {renderPricing && (
                      <td className="p-3">{renderPricing(w.id)}</td>
                    )}
                    <td className="p-3">
                      {suite?.name ?? "Legacy / not reviewed"}
                      <div className="text-xs text-muted-foreground">
                        {policy
                          ? override
                            ? "Warehouse exception"
                            : "Inherited default"
                          : "Not migrated"}
                      </div>
                    </td>
                    <td className="p-3">
                      {!policy ? (
                        "Review required"
                      ) : (
                        <>
                          <span
                            className={
                              !available.length ? "text-destructive" : ""
                            }
                          >
                            {available.length} of {suite?.boxIds.length ?? 0}{" "}
                            permitted boxes available
                          </span>
                          <details className="mt-1 text-xs">
                            <summary>View boxes</summary>
                            {available.length ? (
                              available.map((b) => (
                                <div key={b.id}>
                                  {b.code} — {b.name}
                                </div>
                              ))
                            ) : (
                              <div>
                                No reviewed boxes are available here. Update
                                warehouse availability or assign another suite.
                              </div>
                            )}
                          </details>
                        </>
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit ${w.name} suite`}
                        disabled={!policy}
                        onClick={() =>
                          setEditing({
                            channelId: channel.id,
                            warehouseId: w.id,
                          })
                        }
                      >
                        {override ? "Edit exception" : "Add exception"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </Button>
          <span>
            Page {currentPage + 1} of {pages}
          </span>
          <Button
            variant="outline"
            disabled={currentPage + 1 >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        The program chooses a suite; each warehouse separately controls which
        physical packaging is available there. A warehouse exception changes
        only this program at that warehouse.
      </p>
      {editing && (
        <ChannelPackagingEditor
          key={`${editing.channelId}:${editing.warehouseId}`}
          data={data}
          {...editing}
          dropship={dropship}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await query.refetch({ throwOnError: true });
            setMessage(
              "Packaging saved. New plans use the reviewed configuration.",
            );
          }}
        />
      )}
    </section>
  );
}

export function ChannelPackagingEditor({
  data,
  channelId,
  warehouseId,
  dropship,
  onClose,
  onSaved,
}: {
  data: PackagingPolicyOverview;
  channelId: number;
  warehouseId: number | null;
  dropship: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [opened] = useState(data);
  const policy = opened.policies.find((p) => p.channelId === channelId);
  const initialSuite =
    warehouseId === null
      ? String(policy?.defaultSuiteId ?? "")
      : String(
          policy?.overrides.find((o) => o.warehouseId === warehouseId)
            ?.suiteId ?? "inherit",
        );
  const [suite, setSuite] = useState(initialSuite);
  const [warehouseOverrides] = useState(policy?.overrides ?? []);
  const [requirement, setRequirement] = useState<
    ChannelPackagingPolicy["requirement"]
  >(policy?.requirement ?? "any");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const commandFor = useConfigurationCommand();
  const client = useQueryClient();
  const selectedSuiteId =
    suite === "inherit" ? policy?.defaultSuiteId : Number(suite);
  const selected = opened.suites.find((s) => s.id === selectedSuiteId);
  const enabledWarehouseIds = new Set(
    opened.warehouseAssignments
      .filter(
        (assignment) =>
          assignment.channelId === channelId && assignment.enabled,
      )
      .map((assignment) => assignment.warehouseId),
  );
  const nextOverrides = (
    warehouseId === null
      ? warehouseOverrides
      : [
          ...(policy?.overrides ?? []).filter(
            (override) => override.warehouseId !== warehouseId,
          ),
          ...(suite === "inherit"
            ? []
            : [{ warehouseId, suiteId: Number(suite) }]),
        ]
  )
    .filter((override) => enabledWarehouseIds.has(override.warehouseId))
    .sort((left, right) => left.warehouseId - right.warehouseId);
  const nextDefaultSuiteId =
    warehouseId === null ? Number(suite) : policy?.defaultSuiteId;
  const enabledWarehouses = opened.warehouses.filter((warehouse) =>
    enabledWarehouseIds.has(warehouse.id),
  );
  const relevantSuiteIds = new Set(
    [nextDefaultSuiteId, ...nextOverrides.map((override) => override.suiteId)]
      .filter((id): id is number => Boolean(id)),
  );
  const conflictingSuites = opened.suites.filter(
    (candidate) =>
      relevantSuiteIds.has(candidate.id) &&
      opened.boxes
        .filter((box) => candidate.boxIds.includes(box.id))
        .some(
          (box) => !packagingBrandingAllowed(requirement, box.branding),
        ),
  );
  const strandedWarehouses = enabledWarehouses.filter((warehouse) => {
    const suiteId =
      nextOverrides.find(
        (override) => override.warehouseId === warehouse.id,
      )?.suiteId ?? nextDefaultSuiteId;
    const candidate = opened.suites.find((item) => item.id === suiteId);
    const members = opened.boxes.filter((box) =>
      candidate?.boxIds.includes(box.id),
    );
    return !eligiblePackagingBoxes(
      members,
      warehouse.id,
      requirement,
    ).length;
  });
  const dirty =
    suite !== initialSuite ||
    requirement !== (policy?.requirement ?? "any") ||
    JSON.stringify(nextOverrides) !==
      JSON.stringify(policy?.overrides ?? []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {warehouseId === null
              ? "Program packaging default"
              : "Warehouse suite exception"}
          </DialogTitle>
          <DialogDescription>
            {opened.channels.find((c) => c.id === channelId)?.name} ·{" "}
            {warehouseId === null
              ? "All enabled warehouses without an exception"
              : opened.warehouses.find((w) => w.id === warehouseId)?.name}
          </DialogDescription>
        </DialogHeader>
        {warehouseId === null && (
          <label className="grid gap-1 text-sm">
            Branding requirement
            <select
              aria-label="Branding requirement"
              className="h-10 rounded border bg-background px-2"
              value={requirement}
              disabled={busy}
              onChange={(e) =>
                setRequirement(packagingRequirementSchema.parse(e.target.value))
              }
            >
              <option value="any">Any branding permitted</option>
              <option value="unbranded">White label only</option>
            </select>
          </label>
        )}
        <label className="grid gap-1 text-sm">
          {warehouseId === null ? "Default suite" : "Suite exception"}
          <select
            aria-label="Assigned box suite"
            className="h-10 rounded border bg-background px-2"
            value={suite}
            disabled={busy}
            onChange={(e) => setSuite(e.target.value)}
          >
            {warehouseId === null ? (
              <option value="" disabled>
                Choose suite
              </option>
            ) : (
              <option value="inherit">Use program default</option>
            )}
            {opened.suites
              .filter((s) => !s.archived)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        {warehouseId === null && (
          <p className="text-sm text-muted-foreground">
            Existing warehouse exceptions are preserved. Edit an enabled
            warehouse in the program table to add or remove its exception.
          </p>
        )}
        {conflictingSuites.length > 0 && (
          <p role="alert" className="text-destructive">
            White-label packaging conflicts with{" "}
            {conflictingSuites.map((candidate) => candidate.name).join(", ")}.
            Every suite used by this program must contain only unbranded
            packaging.
          </p>
        )}
        {selected && strandedWarehouses.length > 0 && (
          <p role="alert" className="text-destructive">
            This configuration leaves no usable packaging at{" "}
            {strandedWarehouses
              .slice(0, 5)
              .map((warehouse) => warehouse.name)
              .join(", ")}
            {strandedWarehouses.length > 5
              ? " and " + (strandedWarehouses.length - 5) + " more"
              : ""}
            . Update physical warehouse availability or choose a different
            suite.
          </p>
        )}
        {!policy && (
          <p className="text-sm text-muted-foreground">
            Saving replaces legacy packaging for this channel. Review warehouse
            coverage in the assignment table before operational use.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={
              busy ||
              !dirty ||
              !suite ||
              !selected ||
              conflictingSuites.length > 0 ||
              strandedWarehouses.length > 0
            }
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const body = {
                  channelId,
                  expectedRevision: policy?.revision ?? 0,
                  defaultSuiteId: nextDefaultSuiteId!,
                  requirement,
                  overrides: nextOverrides,
                };
                await putJson(
                  dropship
                    ? "/api/dropship/admin/shipping/shared/packaging-policies"
                    : "/api/shipping/admin/packaging-policies",
                  { ...body, commandId: commandFor(body) },
                );
                invalidateShippingAdmin(client);
                await onSaved();
                onClose();
              } catch (e) {
                setError(
                  e instanceof Error ? e.message : "Unable to save packaging.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy
              ? "Saving…"
              : warehouseId === null
                ? "Save program default"
                : "Save warehouse exception"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
