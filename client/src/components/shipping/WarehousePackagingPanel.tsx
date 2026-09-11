import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { PackagingPolicyOverview } from "@shared/shipping/packaging-policy";
import { useChannelPackagingOverview } from "./ChannelPackagingPanel";
import { CatalogBoxPicker } from "./CatalogBoxPicker";
import { useConfigurationCommand } from "./configuration-client";
import { invalidateShippingAdmin, putJson } from "./pricing-programs/api";

type AvailabilityDraft = {
  data: PackagingPolicyOverview;
  warehouseIds: number[];
};

const PAGE_SIZE = 25;

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
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [draft, setDraft] = useState<AvailabilityDraft | null>(null);
  const [message, setMessage] = useState("");
  const data = query.data;

  if (!data) {
    return (
      <div role={query.isError ? "alert" : undefined}>
        {query.isError
          ? "Unable to load warehouse packaging availability."
          : "Loading warehouse packaging availability…"}{" "}
        <Button variant="outline" onClick={() => query.refetch()}>
          Retry
        </Button>
      </div>
    );
  }

  const warehouses = data.warehouses.filter(
    (warehouse) =>
      (!warehouseId || warehouse.id === warehouseId) &&
      warehouse.name.toLowerCase().includes(search.toLowerCase()),
  );
  const currentPage = Math.min(
    page,
    Math.max(0, Math.ceil(warehouses.length / PAGE_SIZE) - 1),
  );
  const visibleWarehouses = warehouses.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  const availableBoxesFor = (id: number) =>
    data.boxes.filter(
      (box) => box.isActive && box.warehouseIds.includes(id),
    );
  const openAvailability = (warehouseIds: number[]) => {
    setMessage("");
    setDraft({ data, warehouseIds });
  };
  const refresh = async () => {
    invalidateShippingAdmin(client);
    await query.refetch({ throwOnError: true });
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {warehouseId
              ? "Packaging available at this warehouse"
              : "Warehouse packaging availability"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose the physical packaging this warehouse can use. This does not
            enable fulfillment programs, assign program suites, change pricing,
            or track packaging inventory.
          </p>
        </div>
        <Button variant="outline" onClick={() => query.refetch()}>
          Refresh availability
        </Button>
      </div>

      {message && (
        <p role="status" className="text-emerald-700">
          {message}
        </p>
      )}

      {!warehouseId && (
        <Input
          aria-label="Search warehouses"
          className="max-w-sm"
          value={search}
          placeholder="Search warehouses"
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
      )}

      {canEdit && !warehouseId && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button
            variant="outline"
            disabled={!warehouses.length || warehouses.length > 1000}
            onClick={() =>
              setSelected(warehouses.map((warehouse) => warehouse.id))
            }
          >
            Select all {warehouses.length} matching warehouses
          </Button>
          <Button variant="ghost" onClick={() => setSelected([])}>
            Clear warehouses
          </Button>
          <span>{selected.length} selected across pages</span>
          <Button
            disabled={!selected.length}
            onClick={() => openAvailability(selected)}
          >
            Change availability
          </Button>
        </div>
      )}

      {warehouseId ? (
        <div className="space-y-3">
          {visibleWarehouses.map((warehouse) => {
            const availableBoxes = availableBoxesFor(warehouse.id);
            return (
              <article
                key={warehouse.id}
                className="space-y-3 rounded border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">{warehouse.name}</h3>
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={"Edit " + warehouse.name + " availability"}
                      onClick={() => openAvailability([warehouse.id])}
                    >
                      Edit availability
                    </Button>
                  )}
                </div>
                <p className="text-sm text-muted-foreground">
                  {availableBoxes.length} active packaging{" "}
                  {availableBoxes.length === 1 ? "type" : "types"} available
                </p>
                {availableBoxes.length ? (
                  <ul className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
                    {availableBoxes.map((box) => (
                      <li key={box.id} className="rounded bg-muted/40 px-3 py-2">
                        <span className="font-medium">{box.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {box.code}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                    No active packaging is available at this warehouse.
                  </p>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border">
          <table className="w-full min-w-[42rem] text-left text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                {canEdit && <th className="w-10 p-3">Select</th>}
                <th className="p-3">Warehouse</th>
                <th className="p-3">Available packaging</th>
                <th className="p-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {visibleWarehouses.map((warehouse) => {
                const availableBoxes = availableBoxesFor(warehouse.id);
                const names = availableBoxes
                  .slice(0, 3)
                  .map((box) => box.name)
                  .join(", ");
                return (
                  <tr key={warehouse.id} className="border-b last:border-0">
                    {canEdit && (
                      <td className="p-3">
                        <input
                          type="checkbox"
                          aria-label={"Select " + warehouse.name}
                          checked={selected.includes(warehouse.id)}
                          onChange={(event) =>
                            setSelected((ids) =>
                              event.target.checked
                                ? [...ids, warehouse.id]
                                : ids.filter((id) => id !== warehouse.id),
                            )
                          }
                        />
                      </td>
                    )}
                    <th scope="row" className="p-3 font-medium">
                      {warehouse.name}
                    </th>
                    <td className="p-3">
                      <div>
                        {availableBoxes.length} active{" "}
                        {availableBoxes.length === 1 ? "type" : "types"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {names || "None available"}
                        {availableBoxes.length > 3
                          ? " and " + (availableBoxes.length - 3) + " more"
                          : ""}
                      </div>
                    </td>
                    <td className="p-3 text-right">
                      {canEdit ? (
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={
                            "Edit " + warehouse.name + " availability"
                          }
                          onClick={() => openAvailability([warehouse.id])}
                        >
                          Edit availability
                        </Button>
                      ) : (
                        <span className="text-muted-foreground">View only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!warehouses.length && (
        <p className="rounded border p-4 text-sm text-muted-foreground">
          No warehouse matches this view.
        </p>
      )}

      {!warehouseId && warehouses.length > PAGE_SIZE && (
        <div className="flex items-center gap-2 text-sm">
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
            disabled={(currentPage + 1) * PAGE_SIZE >= warehouses.length}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      )}

      {draft && (
        <WarehouseAvailabilityEditor
          draft={draft}
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

function WarehouseAvailabilityEditor({
  draft,
  onClose,
  onSaved,
}: {
  draft: AvailabilityDraft;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const [boxIds, setBoxIds] = useState<number[]>([]);
  const [available, setAvailable] = useState(true);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const commandFor = useConfigurationCommand();
  const { data, warehouseIds } = draft;
  const affected = data.warehouses.filter((warehouse) =>
    warehouseIds.includes(warehouse.id),
  );
  const inactiveSelection =
    available &&
    data.boxes.some((box) => boxIds.includes(box.id) && !box.isActive);
  const ready = boxIds.length > 0 && !inactiveSelection;

  async function save() {
    setBusy(true);
    setError("");
    const body = {
      warehouses: affected.map((warehouse) => ({
        id: warehouse.id,
        revision: warehouse.packagingRevision,
      })),
      boxIds: [...boxIds].sort((a, b) => a - b),
      available,
    };
    try {
      const result = await putJson<{ changed: number; skipped: number }>(
        "/api/shipping/admin/warehouse-packaging/availability",
        { ...body, commandId: commandFor(body) },
      );
      await onSaved(
        "Availability saved. " +
          result.changed +
          " changes; " +
          result.skipped +
          " unchanged.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Unable to save packaging availability.",
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
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {review
              ? "Review availability changes"
              : "Change physical packaging availability"}
          </DialogTitle>
          <DialogDescription>
            {affected.length === 1
              ? affected[0].name
              : affected.length + " selected warehouses"}
            . Fulfillment programs, program suites, pricing, and inventory counts
            will not change.
          </DialogDescription>
        </DialogHeader>

        {!review ? (
          <div className="space-y-3">
            <label className="grid gap-1 text-sm">
              Change
              <select
                aria-label="Availability change"
                className="h-10 rounded border px-2"
                value={available ? "add" : "remove"}
                onChange={(event) => {
                  setAvailable(event.target.value === "add");
                  setBoxIds([]);
                }}
              >
                <option value="add">Add selected packaging</option>
                <option value="remove">Remove selected packaging</option>
              </select>
            </label>
            <CatalogBoxPicker
              boxes={data.boxes}
              selected={boxIds}
              onChange={setBoxIds}
              allowInactive={!available}
            />
            {inactiveSelection && (
              <p role="alert" className="text-sm text-destructive">
                Inactive packaging cannot be added. Remove it from the selection
                or activate it in the catalog first.
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              {available ? "Add" : "Remove"} {boxIds.length} packaging{" "}
              {boxIds.length === 1 ? "type" : "types"}{" "}
              {available ? "at" : "from"} {affected.length}{" "}
              {affected.length === 1 ? "warehouse" : "warehouses"}.
            </p>
            <details open={affected.length <= 10}>
              <summary>Warehouses</summary>
              <ul className="max-h-40 overflow-auto">
                {affected.slice(0, 50).map((warehouse) => (
                  <li key={warehouse.id}>{warehouse.name}</li>
                ))}
                {affected.length > 50 && (
                  <li>{affected.length - 50} more warehouses</li>
                )}
              </ul>
            </details>
            <details open={boxIds.length <= 10}>
              <summary>Packaging</summary>
              <ul className="max-h-40 overflow-auto">
                {data.boxes
                  .filter((box) => boxIds.includes(box.id))
                  .slice(0, 50)
                  .map((box) => (
                    <li key={box.id}>
                      {box.code} · {box.name}
                    </li>
                  ))}
                {boxIds.length > 50 && (
                  <li>{boxIds.length - 50} more packaging types</li>
                )}
              </ul>
            </details>
            {!available && (
              <p className="text-amber-700">
                Removing availability can leave a program suite without usable
                packaging. Quotes and packing will reject unavailable packaging.
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
                {busy ? "Saving…" : "Save availability"}
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
