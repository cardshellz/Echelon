import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { pickCorrectionListSchema, pickCorrectionSchema, type PickCorrection } from "@shared/pick-corrections";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const queryKey = ["/api/picking/corrections"] as const;

async function readCorrections(signal: AbortSignal): Promise<PickCorrection[]> {
  const response = await fetch(queryKey[0], { signal, credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("Could not load pick corrections. Retry before leaving the gun.");
  return pickCorrectionListSchema.parse(await response.json());
}

/** Independent of the ordinary queue: a shipped header must never hide this work. */
export function PickCorrections({ userId, canPerform }: { userId: string; canPerform: boolean }) {
  const query = useQuery({ queryKey, queryFn: ({ signal }) => readCorrections(signal), refetchInterval: 5_000 });
  const [notice, setNotice] = useState<string | null>(null);
  const corrections = query.data ?? [];
  const available = corrections.filter(item => item.assignedPickerId === null || item.assignedPickerId === userId);
  const prompt = canPerform ? available.find(item => item.state === "confirmation_required") : undefined;
  const changed = (item: PickCorrection) => {
    if (item.state === "resolved") setNotice(`Pick record corrected for ${item.orderNumber}, ${item.sku}. Finish any box or label changes in ShipStation. The original shipment was not resent.`);
  };
  if (query.isError) return <section className="border-b bg-amber-50 p-3" role="alert">
    Pick corrections could not be loaded. <Button variant="outline" onClick={() => void query.refetch()}>Retry</Button>
  </section>;
  return <>
    {notice && <div className="border-b bg-green-50 p-3 text-sm" role="status">{notice}</div>}
    {corrections.length > 0 && <section className="border-b bg-amber-50 p-3 space-y-3" aria-label="Pick corrections">
      <h2 className="font-semibold">Pick corrections ({corrections.length})</h2>
      {corrections.map(item => <article key={item.id} className="rounded border bg-background p-3 space-y-2">
        <h3 className="font-semibold">{item.orderNumber} · {item.sku}</h3>
        <p className="text-sm">{item.declaredQuantity - item.pickedQuantity} still need a pick record · {item.location || "Source bin missing"}</p>
        {item.assignedPickerId !== null && item.assignedPickerId !== userId
          ? <p className="text-sm">Being resolved by another picker.</p>
          : canPerform && item.state === "picking_required"
            ? <CorrectionAction key={`${item.id}:${item.revision}:${item.pickedQuantity}`} item={item} onChanged={changed} />
            : <p className="text-sm">Waiting for the picker’s Yes / No confirmation.</p>}
      </article>)}
    </section>}
    <AlertDialog open={Boolean(prompt)}>
      <AlertDialogContent onEscapeKeyDown={event => event.preventDefault()} className="max-h-[90dvh] w-[calc(100vw-2rem)] overflow-auto rounded-lg">
        <AlertDialogTitle>Was this item actually picked?</AlertDialogTitle>
        <AlertDialogDescription>
          ShipStation declares this item in the shipment, but Echelon is missing its pick record.
        </AlertDialogDescription>
        {prompt && <CorrectionAction key={`${prompt.id}:${prompt.revision}`} item={prompt} onChanged={changed} />}
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

function CorrectionAction({ item, onChanged }: { item: PickCorrection; onChanged(item: PickCorrection): void }) {
  const client = useQueryClient();
  const [barcode, setBarcode] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An uncertain response retries the identical command, not a second inventory request.
  const pending = useRef<{ endpoint: string; body: Record<string, unknown> } | null>(null);
  const missing = item.declaredQuantity - item.pickedQuantity;
  const submit = async (action: "yes" | "no" | "pick") => {
    if (busy) return;
    const amount = Number(quantity);
    if (!pending.current && action === "pick" && (!Number.isSafeInteger(amount) || amount < 1 || amount > missing || !barcode.trim())) {
      setError(`Scan the item and enter between 1 and ${missing} units.`); return;
    }
    const command = pending.current ?? {
      endpoint: `${queryKey[0]}/${item.id}/${action === "pick" ? "pick" : "answer"}`,
      body: { commandId: crypto.randomUUID(), expectedRevision: item.revision,
        ...(action === "pick" ? { pickedQuantity: item.pickedQuantity + amount, barcode: barcode.trim() } : { answer: action }) },
    };
    pending.current = command; setBusy(true); setError(null);
    try {
      const response = await fetch(command.endpoint, { method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(command.body) });
      const result: unknown = await response.json();
      if (!response.ok) {
        // The server retained any accepted answer. Refetch shows the durable next step.
        pending.current = null;
        const message = result && typeof result === "object" && "error" in result ? String(result.error) : "Correction was not saved.";
        throw new Error(message);
      }
      const updated = pickCorrectionSchema.parse(result);
      pending.current = null;
      client.setQueryData<PickCorrection[]>(queryKey, current => (current ?? []).flatMap(row =>
        row.id !== updated.id ? [row] : updated.state === "resolved" ? [] : [updated]));
      onChanged(updated);
      await client.invalidateQueries({ queryKey: ["/api/picking/queue"] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Connection lost. Retry the same command.");
    } finally {
      setBusy(false);
      await client.invalidateQueries({ queryKey });
    }
  };
  return <div className="space-y-3">
    {item.state === "confirmation_required" && <>
      <p className="font-semibold">{item.orderNumber} · {item.sku}</p>
      <p>{item.name}</p>
      <p>{missing} unit(s) have no pick record. Were these actually picked and put in the shipment?</p>
      <div className="grid grid-cols-2 gap-3">
        <Button className="h-12" disabled={busy || Boolean(pending.current && pending.current.body.answer !== "yes")} onClick={() => void submit("yes")}>Yes</Button>
        <Button className="h-12" variant="outline" disabled={busy || Boolean(pending.current && pending.current.body.answer !== "no")} onClick={() => void submit("no")}>No</Button>
      </div>
    </>}
    {item.state === "picking_required" && item.answer === "yes" && <>
      <p className="text-sm">Your Yes is saved. The missing pick still needs to be recorded.</p>
      <Button disabled={busy} onClick={() => void submit("yes")}>Retry recording confirmed pick</Button>
    </>}
    {item.state === "picking_required" && item.answer === "no" && <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit("pick"); }}>
      <p className="text-sm">Pick only these missing units from {item.location || "the recorded source bin"}. Leave the other order items alone.</p>
      <label className="block text-sm">Scan item barcode or SKU
        <Input value={barcode} onChange={event => setBarcode(event.target.value)} disabled={busy} autoComplete="off" />
      </label>
      <label className="block text-sm">Quantity picked now
        <Input type="number" inputMode="numeric" min={1} max={missing} step={1} value={quantity} onChange={event => setQuantity(event.target.value)} disabled={busy} />
      </label>
      <Button className="h-12 w-full" type="submit" disabled={busy}>Record corrective pick</Button>
    </form>}
    {(error || item.reviewReason) && <p role="alert" className="text-sm text-destructive">{error || item.reviewReason}</p>}
  </div>;
}
