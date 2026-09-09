import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DropshipSharedShippingConfig } from "@shared/shipping/configuration";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfigurationCommand } from "./configuration-client";
import {
  invalidateShippingAdmin,
  postJson,
  putJson,
} from "./pricing-programs/api";

export function DropshipProgramEditor({
  data,
  warehouseId,
  onSaved,
  onClose,
}: {
  data: DropshipSharedShippingConfig;
  warehouseId: number | null;
  onSaved: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [openedData] = useState(data);
  const assignment = openedData.assignments.find(
    (a) => a.warehouseId === warehouseId,
  );
  const fallback = openedData.assignments.find((a) => a.warehouseId === null);
  const initial = assignment?.rateBookId
    ? String(assignment.rateBookId)
    : warehouseId === null
      ? ""
      : "inherit";
  const [program, setProgram] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const client = useQueryClient();
  const commandFor = useConfigurationCommand();
  const scope =
    warehouseId === null
      ? "Channel default"
      : (data.packaging.warehouses.find((w) => w.id === warehouseId)?.name ??
        `Warehouse ${warehouseId}`);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit pricing program</DialogTitle>
        </DialogHeader>
        <p>Dropship · {scope}</p>
        <label className="grid gap-2 text-sm">
          Pricing program
          <select
            aria-label="Dropship pricing program"
            disabled={busy}
            className="h-10 w-full rounded border bg-background px-2"
            value={program}
            onChange={(e) => {
              setProgram(e.target.value);
              setError("");
            }}
          >
            {warehouseId === null ? (
              <option value="" disabled>
                Choose pricing program
              </option>
            ) : (
              <option value="inherit" disabled={!fallback?.rateBookId}>
                Use channel default —{" "}
                {data.programs.find((p) => p.id === fallback?.rateBookId)
                  ?.name ?? "Not configured"}
              </option>
            )}
            {data.programs.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <p className="text-sm text-muted-foreground">
          {warehouseId === null
            ? "Used at warehouses without a pricing override."
            : "Applies to quotes originating at this warehouse only."}{" "}
          Rates, markup and insurance remain defined in the pricing program.
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            disabled={busy || !program || program === initial}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                const body = {
                  warehouseId,
                  expectedProgramId: assignment?.rateBookId ?? null,
                  ...(program === "inherit"
                    ? {}
                    : { rateBookId: Number(program) }),
                };
                const endpoint = "/api/dropship/admin/shipping/shared/program";
                if (program === "inherit")
                  await postJson(`${endpoint}/reset`, {
                    ...body,
                    commandId: commandFor(body),
                  });
                else
                  await putJson(endpoint, {
                    ...body,
                    commandId: commandFor(body),
                  });
                invalidateShippingAdmin(client);
                await onSaved();
                onClose();
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "Unable to save pricing program.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save program"}
          </Button>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
