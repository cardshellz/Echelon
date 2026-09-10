import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { PackagingPolicyOverview } from "@shared/shipping/packaging-policy";
import {
  eligiblePackagingBoxes,
  packagingBrandingAllowed,
} from "@shared/shipping/packaging-eligibility";
import { useChannelPackagingOverview } from "./ChannelPackagingPanel";
import { CatalogBoxPicker } from "./CatalogBoxPicker";
import { useConfigurationCommand } from "./configuration-client";
import { invalidateShippingAdmin, putJson } from "./pricing-programs/api";

type Draft = {
  kind: "availability" | "suites";
  data: PackagingPolicyOverview;
  warehouseIds: number[];
};
export function WarehousePackagingPanel({
  warehouseId,
  canEdit = false,
}: {
  warehouseId?: number;
  canEdit?: boolean;
}) {
  const query = useChannelPackagingOverview();
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [program, setProgram] = useState(
    Number(new URLSearchParams(location.search).get("channelId")) || 0,
  );
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState("");
  const data = query.data;
  if (!data)
    return (
      <div role={query.isError ? "alert" : undefined}>
        {query.isError
          ? "Unable to load warehouse packaging."
          : "Loading warehouse packaging…"}
        <Button variant="outline" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  const warehouses = data.warehouses.filter(
    (w) =>
      (!warehouseId || w.id === warehouseId) &&
      w.name.toLowerCase().includes(search.toLowerCase()),
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(warehouses.length / 25) - 1),
  );
  const channels = data.channels.filter(
    (c) => c.status === "active" && (!program || c.id === program),
  );
  const open = (kind: Draft["kind"], ids: number[]) => {
    setMessage("");
    setDraft({ kind, data, warehouseIds: ids });
  };
  const refresh = async () => {
    invalidateShippingAdmin(client);
    await query.refetch({ throwOnError: true });
  };
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Warehouse packaging</h2>
          <p className="text-sm text-muted-foreground">
            Configure packaging available at each warehouse, then choose a suite
            for each fulfillment program. These settings do not enable
            warehouses for fulfillment or change pricing.
          </p>
          <div className="flex gap-4 text-sm mt-2">
            <a className="underline" href="/shipping-settings?tab=boxes">
              Box catalog
            </a>
            <a className="underline" href="/shipping-settings?tab=box-suites">
              Box suites
            </a>
          </div>
        </div>
        <Button variant="outline" onClick={() => query.refetch()}>
          Refresh packaging
        </Button>
      </div>
      {message && (
        <p role="status" className="text-emerald-700">
          {message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Search warehouses"
          className="max-w-sm"
          value={search}
          placeholder="Search warehouses"
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
        />
        <select
          className="border rounded h-10 px-2 max-w-full"
          aria-label="Filter fulfillment program"
          value={program}
          onChange={(e) => setProgram(Number(e.target.value))}
        >
          <option value={0}>All fulfillment programs</option>
          {data.channels
            .filter((c) => c.status === "active")
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </div>
      {canEdit && !warehouseId && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button
            variant="outline"
            disabled={!warehouses.length || warehouses.length > 1000}
            onClick={() => setSelected(warehouses.map((w) => w.id))}
          >
            Select all {warehouses.length} matching warehouses
          </Button>
          <Button variant="ghost" onClick={() => setSelected([])}>
            Clear warehouses
          </Button>
          <span>{selected.length} selected across pages</span>
          <Button
            disabled={!selected.length}
            onClick={() => open("availability", selected)}
          >
            Update available packaging
          </Button>
          <Button
            disabled={!selected.length}
            onClick={() => open("suites", selected)}
          >
            Assign program suites
          </Button>
        </div>
      )}
      <div className="space-y-3">
        {warehouses.slice(currentPage * 25, (currentPage + 1) * 25).map((w) => (
          <article key={w.id} className="rounded border p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2 items-center">
                {canEdit && !warehouseId && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${w.name}`}
                    checked={selected.includes(w.id)}
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked
                          ? [...ids, w.id]
                          : ids.filter((id) => id !== w.id),
                      )
                    }
                  />
                )}
                <h3 className="font-semibold">{w.name}</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                {canEdit && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => open("availability", [w.id])}
                    >
                      Available packaging
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => open("suites", [w.id])}
                    >
                      Assign suite
                    </Button>
                  </>
                )}
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              {
                data.boxes.filter(
                  (b) => b.isActive && b.warehouseIds.includes(w.id),
                ).length
              }{" "}
              active packaging types available
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="p-2">Fulfillment program</th>
                    <th className="p-2">Effective suite</th>
                    <th className="p-2">Usable here</th>
                  </tr>
                </thead>
                <tbody>
                  {channels.map((c) => {
                    const policy = data.policies.find(
                      (p) => p.channelId === c.id,
                    );
                    const override = policy?.overrides.find(
                      (o) => o.warehouseId === w.id,
                    );
                    const suite = data.suites.find(
                      (s) =>
                        s.id === (override?.suiteId ?? policy?.defaultSuiteId),
                    );
                    const eligible =
                      suite && policy
                        ? eligiblePackagingBoxes(
                            data.boxes.filter((b) =>
                              suite.boxIds.includes(b.id),
                            ),
                            w.id,
                            policy.requirement,
                          ).length
                        : 0;
                    return (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="p-2">{c.name}</td>
                        <td className="p-2">
                          {suite?.name ?? "Not configured"}
                          <div className="text-xs text-muted-foreground">
                            {policy
                              ? override
                                ? "Warehouse assignment"
                                : "Program default"
                              : "Use Assign suite to configure this program"}
                          </div>
                        </td>
                        <td
                          className={`p-2 ${!eligible ? "text-amber-700" : ""}`}
                        >
                          {eligible
                            ? `${eligible} packaging types`
                            : "No usable packaging"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </article>
        ))}
      </div>
      {!warehouseId && (
        <div className="flex gap-2 items-center text-sm">
          <span>
            {warehouses.length} matching · Page {currentPage + 1}
          </span>
          <Button
            variant="outline"
            disabled={!currentPage}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            disabled={(currentPage + 1) * 25 >= warehouses.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      )}
      {draft && (
        <WarehousePackagingEdit
          draft={draft}
          initialProgram={program}
          onClose={() => setDraft(null)}
          onSaved={async (result) => {
            await refresh();
            setDraft(null);
            setMessage(result);
            setSelected([]);
          }}
        />
      )}
    </section>
  );
}

function WarehousePackagingEdit({
  draft,
  initialProgram,
  onClose,
  onSaved,
}: {
  draft: Draft;
  initialProgram: number;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [boxIds, setBoxIds] = useState<number[]>([]);
  const [suiteId, setSuiteId] = useState(0);
  const [channelId, setChannelId] = useState(initialProgram);
  const [defaultSuiteId, setDefaultSuiteId] = useState(0);
  const [requirement, setRequirement] = useState<"any" | "unbranded">("any");
  const [available, setAvailable] = useState(true);
  const [replace, setReplace] = useState(false);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const commandFor = useConfigurationCommand();
  const { data, warehouseIds, kind } = draft;
  const policy = data.policies.find((p) => p.channelId === channelId);
  const suite = data.suites.find((s) => s.id === suiteId);
  const affected = data.warehouses.filter((w) => warehouseIds.includes(w.id));
  const exceptions =
    policy?.overrides.filter((o) => warehouseIds.includes(o.warehouseId))
      .length ?? 0;
  const effectiveSuite =
    suite ??
    data.suites.find(
      (s) => s.id === (policy?.defaultSuiteId ?? defaultSuiteId),
    );
  const members = data.boxes.filter((b) =>
    effectiveSuite?.boxIds.includes(b.id),
  );
  const targetRequirement = policy?.requirement ?? requirement;
  const brandingConflict = members.some(
    (b) => !packagingBrandingAllowed(targetRequirement, b.branding),
  );
  const unusable = affected.filter(
    (w) =>
      (replace || !policy?.overrides.some((o) => o.warehouseId === w.id)) &&
      !eligiblePackagingBoxes(members, w.id, targetRequirement).length,
  );
  const inactiveSelection =
    available && data.boxes.some((b) => boxIds.includes(b.id) && !b.isActive);
  const ready =
    kind === "availability"
      ? boxIds.length > 0 && !inactiveSelection
      : Boolean(
          channelId &&
            (policy || defaultSuiteId) &&
            !brandingConflict &&
            !unusable.length,
        );
  const chosenBoxes =
    suiteId && kind === "availability"
      ? data.boxes.filter((b) => suite?.boxIds.includes(b.id))
      : data.boxes;
  async function save() {
    setBusy(true);
    setError("");
    try {
      const body =
        kind === "availability"
          ? {
              warehouses: affected.map((w) => ({
                id: w.id,
                revision: w.packagingRevision,
              })),
              boxIds: [...boxIds].sort((a, b) => a - b),
              available,
              ...(suite
                ? { sourceSuite: { id: suite.id, revision: suite.revision } }
                : {}),
            }
          : {
              channelId,
              expectedRevision: policy?.revision ?? 0,
              ...(!policy
                ? { initialPolicy: { defaultSuiteId, requirement } }
                : {}),
              warehouseIds: [...warehouseIds].sort((a, b) => a - b),
              suiteId: suiteId || null,
              replaceExisting: replace,
            };
      const result = await putJson<{ changed: number; skipped: number }>(
        `/api/shipping/admin/warehouse-packaging/${kind === "availability" ? "availability" : "suites"}`,
        { ...body, commandId: commandFor(body) },
      );
      await onSaved(
        `Saved. ${result.changed} changes; ${result.skipped} unchanged.${!policy && kind === "suites" ? " Program defaults created; selected warehouse assignments saved." : " Unselected warehouses were not modified."}`,
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Unable to save warehouse packaging.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {review
              ? "Review changes"
              : kind === "availability"
                ? "Available packaging"
                : "Assign program suite"}
          </DialogTitle>
          <DialogDescription>
            {affected.length === 1
              ? affected[0].name
              : `${affected.length} selected warehouses`}
            .{" "}
            {kind === "suites" && !policy && channelId > 0
              ? "New program defaults also apply to warehouses without an exception."
              : "Only selected warehouses will change."}
          </DialogDescription>
        </DialogHeader>
        {!review ? (
          <div className="space-y-3">
            {kind === "availability" ? (
              <>
                <p className="text-sm">
                  Availability means this warehouse can use the packaging; it is
                  not a live stock count. Suite membership and pricing do not
                  change.
                </p>
                {affected.length === 1 && (
                  <details>
                    <summary className="cursor-pointer text-sm">
                      Currently available packaging
                    </summary>
                    <ul className="max-h-40 overflow-auto text-sm">
                      {data.boxes
                        .filter((b) => b.warehouseIds.includes(affected[0].id))
                        .map((b) => (
                          <li key={b.id}>
                            {b.code} · {b.name}
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
                <label className="grid gap-1 text-sm">
                  Action
                  <select
                    className="border rounded h-10 px-2"
                    value={available ? "add" : "remove"}
                    onChange={(e) => setAvailable(e.target.value === "add")}
                  >
                    <option value="add">
                      Make selected packaging available
                    </option>
                    <option value="remove">
                      Remove selected packaging availability
                    </option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm">
                  Choose from
                  <select
                    aria-label="Choose from"
                    className="border rounded h-10 px-2"
                    value={suiteId}
                    onChange={(e) => {
                      setSuiteId(Number(e.target.value));
                      setBoxIds([]);
                    }}
                  >
                    <option value={0}>All catalog packaging</option>
                    {data.suites
                      .filter((s) => !s.archived)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
                <CatalogBoxPicker
                  boxes={chosenBoxes}
                  selected={boxIds}
                  onChange={setBoxIds}
                  allowInactive={!available}
                />
                {inactiveSelection && (
                  <p role="alert">
                    Inactive boxes cannot be made available. Remove them from
                    your selection or activate them in the catalog first.
                  </p>
                )}
                {suite && (
                  <p className="text-xs text-muted-foreground">
                    This uses the current suite members only. Future suite
                    additions are not made available automatically.
                  </p>
                )}
              </>
            ) : (
              <>
                <label className="grid gap-1 text-sm">
                  Fulfillment program
                  <select
                    aria-label="Fulfillment program"
                    className="border rounded h-10 px-2"
                    value={channelId}
                    onChange={(e) => setChannelId(Number(e.target.value))}
                  >
                    <option value={0}>Choose program</option>
                    {data.channels
                      .filter((c) => c.status === "active")
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
                {!policy && channelId > 0 && (
                  <fieldset className="border rounded p-3 space-y-2">
                    <legend className="text-sm">New program defaults</legend>
                    <p className="text-xs text-muted-foreground">
                      This program has no policy yet. These defaults apply to
                      warehouses without an exception. Defaults and selected
                      assignments save together.
                    </p>
                    <label className="grid gap-1 text-sm">
                      Program default suite
                      <select
                        className="border rounded h-10 px-2"
                        value={defaultSuiteId}
                        onChange={(e) =>
                          setDefaultSuiteId(Number(e.target.value))
                        }
                      >
                        <option value={0}>Choose default suite</option>
                        {data.suites
                          .filter((s) => !s.archived)
                          .map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="grid gap-1 text-sm">
                      Program branding requirement
                      <select
                        className="border rounded h-10 px-2"
                        value={requirement}
                        onChange={(e) =>
                          setRequirement(
                            e.target.value === "unbranded"
                              ? "unbranded"
                              : "any",
                          )
                        }
                      >
                        <option value="any">Any branding permitted</option>
                        <option value="unbranded">White label only</option>
                      </select>
                    </label>
                  </fieldset>
                )}
                <label className="grid gap-1 text-sm">
                  Suite
                  <select
                    aria-label="Suite"
                    className="border rounded h-10 px-2"
                    value={suiteId}
                    onChange={(e) => setSuiteId(Number(e.target.value))}
                  >
                    <option value={0}>Use program default</option>
                    {data.suites
                      .filter((s) => !s.archived)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="flex gap-2 items-start text-sm">
                  <input
                    type="checkbox"
                    checked={replace}
                    onChange={(e) => setReplace(e.target.checked)}
                  />
                  Replace existing warehouse assignments ({exceptions}). Leave
                  unchecked to preserve exceptions.
                </label>
                <p className="text-sm text-muted-foreground">
                  Assignments do not change physical availability. The selected
                  suite must contain usable packaging at each affected
                  warehouse.
                </p>
                {brandingConflict && (
                  <p role="alert" className="text-destructive">
                    This suite contains branded or unclassified boxes. Choose an
                    entirely unbranded suite for this program.
                  </p>
                )}
                {effectiveSuite && unusable.length > 0 && (
                  <p role="alert" className="text-destructive">
                    No usable packaging in this suite at{" "}
                    {unusable
                      .slice(0, 5)
                      .map((w) => w.name)
                      .join(", ")}
                    {unusable.length > 5
                      ? ` and ${unusable.length - 5} more warehouses`
                      : ""}
                    . Update available packaging first.
                  </p>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {kind === "suites" && !policy && (
              <p className="text-amber-700">
                Create program default:{" "}
                {data.suites.find((s) => s.id === defaultSuiteId)?.name} ·{" "}
                {requirement === "unbranded"
                  ? "White label only"
                  : "Any branding"}
                . This replaces legacy packaging for this program at warehouses
                without an exception.
              </p>
            )}
            <p>
              {kind === "availability"
                ? `${available ? "Make available" : "Remove availability for"} ${boxIds.length} packaging types at ${affected.length} warehouses.`
                : `Assign ${suite?.name ?? "program default"} for ${data.channels.find((c) => c.id === channelId)?.name}. ${replace ? "Existing assignments may be replaced." : `${exceptions} existing assignments will be preserved.`}`}
            </p>
            <details>
              <summary>Review selected warehouses</summary>
              <ul className="max-h-40 overflow-auto">
                {affected.map((w) => (
                  <li key={w.id}>{w.name}</li>
                ))}
              </ul>
            </details>
            {kind === "availability" && (
              <details>
                <summary>Review selected packaging</summary>
                <ul className="max-h-40 overflow-auto">
                  {data.boxes
                    .filter((b) => boxIds.includes(b.id))
                    .map((b) => (
                      <li key={b.id}>
                        {b.code} · {b.name}
                      </li>
                    ))}
                </ul>
              </details>
            )}
            {!available && kind === "availability" && (
              <p className="text-amber-700">
                Removing availability can leave an assigned suite without usable
                packaging. Quotes and packing will reject unavailable boxes.
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          {review ? (
            <>
              <Button disabled={busy} onClick={() => void save()}>
                Save changes
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setReview(false)}
              >
                Back
              </Button>
            </>
          ) : (
            <Button disabled={!ready} onClick={() => setReview(true)}>
              Review changes
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
