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
  const warehouses = data.warehouses.filter((w) =>
    w.name.toLowerCase().includes(search.toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(warehouses.length / 50));
  const currentPage = Math.min(page, pages - 1);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            Warehouse packaging assignments
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose permitted packaging independently of pricing. Warehouses can
            serve multiple configurations with different suites.
          </p>
        </div>
        <Button variant="outline" onClick={() => query.refetch()}>
          Refresh assignments
        </Button>
      </div>
      <label className="grid max-w-md gap-1 text-sm">
        Fulfillment configuration
        <select
          aria-label="Fulfillment configuration"
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
      <div className="flex flex-wrap items-center justify-between gap-3 rounded border p-4">
        <div>
          <h3 className="font-medium">Default packaging for {channel.name}</h3>
          <p>{suiteName(policy?.defaultSuiteId)}</p>
          <p className="text-xs text-muted-foreground">
            {policy
              ? `${policy.requirement === "unbranded" ? "White label only" : "Any branding"} · Revision ${policy.revision}`
              : "Needs review"}
            . A warehouse override replaces this default.
          </p>
        </div>
        <Button
          variant="outline"
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
      <Input
        className="max-w-sm"
        aria-label="Search packaging warehouses"
        placeholder="Search warehouses"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(0);
        }}
      />
      <div className="max-h-[30rem] overflow-auto rounded border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b">
              <th className="p-3">Warehouse</th>
              <th className="p-3">Pricing configuration</th>
              <th className="p-3">Box suite</th>
              <th className="p-3">Available boxes</th>
              <th className="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
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
                const prices = [
                  ...new Set(
                    data.pricing
                      .filter(
                        (p) =>
                          p.channelId === channel.id &&
                          (p.warehouseId === null || p.warehouseId === w.id),
                      )
                      .map((p) => p.name),
                  ),
                ];
                const eligibility = data.warehouseAssignments.find(
                  (a) => a.channelId === channel.id && a.warehouseId === w.id,
                );
                return (
                  <tr key={w.id} className="border-b align-top last:border-0">
                    <th scope="row" className="p-3 font-medium">
                      {w.name}
                      <div className="text-xs font-normal text-muted-foreground">
                        {eligibility
                          ? eligibility.enabled
                            ? "Assigned to channel"
                            : "Channel assignment disabled"
                          : "No explicit channel warehouse assignment"}
                      </div>
                    </th>
                    <td className="p-3">
                      {renderPricing ? (
                        renderPricing(w.id)
                      ) : (
                        <>
                          <div>
                            {prices.join(", ") ||
                              "No versioned pricing configured"}
                          </div>
                          <a
                            className="text-xs underline"
                            href={`/shipping-settings?tab=channel-routing&channelId=${channel.id}`}
                          >
                            Manage pricing separately
                          </a>
                          {prices.length > 0 && (
                            <div className="text-xs text-muted-foreground">
                              Destination rules determine the applicable rate.
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="p-3">
                      {suite?.name ?? "Legacy / not reviewed"}
                      <div className="text-xs text-muted-foreground">
                        {policy
                          ? override
                            ? "Warehouse override"
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
                        aria-label={`Edit ${w.name} packaging`}
                        asChild
                      >
                        <a
                          href={`/warehouse/packaging?channelId=${channel.id}`}
                        >
                          Manage in Warehouses
                        </a>
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
        Packaging assignments do not enable warehouses or change order routing.
        Availability is configured within each warehouse, not a live stock
        count.
      </p>
      <div className="flex gap-4 text-sm">
        <a className="underline" href="/shipping-settings?tab=boxes">
          Box catalog
        </a>
        <a className="underline" href="/shipping-settings?tab=box-suites">
          Manage suites
        </a>
        <a
          className="underline"
          href={`/warehouse/packaging?channelId=${channel.id}`}
        >
          Manage warehouse packaging
        </a>
      </div>
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
  const members = opened.boxes.filter((b) => selected?.boxIds.includes(b.id));
  const conflict = members.some(
    (b) => !packagingBrandingAllowed(requirement, b.branding),
  );
  const available =
    warehouseId === null
      ? members.filter(
          (b) => b.isActive && b.availabilityReviewed && b.warehouseIds.length,
        )
      : eligiblePackagingBoxes(members, warehouseId, requirement);
  const dirty =
    suite !== initialSuite ||
    requirement !== (policy?.requirement ?? "any") ||
    JSON.stringify(warehouseOverrides) !==
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
            {warehouseId === null ? "Default packaging" : "Warehouse packaging"}
          </DialogTitle>
          <DialogDescription>
            {opened.channels.find((c) => c.id === channelId)?.name} ·{" "}
            {warehouseId === null
              ? "All warehouses without an override"
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
          Box suite
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
              <option value="inherit">Use configuration default</option>
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
            Existing warehouse exceptions are preserved. Manage individual or
            bulk assignments in{" "}
            <a
              className="underline"
              href={`/warehouse/packaging?channelId=${channelId}`}
            >
              Warehouse packaging
            </a>
            .
          </p>
        )}
        {conflict && (
          <p role="alert" className="text-destructive">
            This suite contains branded or unclassified boxes. White-label
            policies require every member to be unbranded.
          </p>
        )}
        {selected && !available.length && (
          <p role="alert" className="text-destructive">
            No reviewed boxes are available
            {warehouseId === null ? " at any warehouse" : " at this warehouse"}.
            Review availability in warehouse packaging first.
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
            disabled={busy || !dirty || !suite || conflict || !available.length}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const overrides =
                  warehouseId === null
                    ? warehouseOverrides
                    : [
                        ...(policy?.overrides ?? []).filter(
                          (o) => o.warehouseId !== warehouseId,
                        ),
                        ...(suite === "inherit"
                          ? []
                          : [{ warehouseId, suiteId: Number(suite) }]),
                      ];
                const body = {
                  channelId,
                  expectedRevision: policy?.revision ?? 0,
                  defaultSuiteId:
                    warehouseId === null
                      ? Number(suite)
                      : policy!.defaultSuiteId,
                  requirement,
                  overrides,
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
            {busy ? "Saving…" : "Save packaging"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
