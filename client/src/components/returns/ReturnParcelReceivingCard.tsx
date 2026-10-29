import { useRef, useState } from "react";
import { z } from "zod";
import {
  returnParcelReceivingSchema,
  returnParcelReceiptInputSchema,
  returnParcelReceiptResultSchema,
  type ReturnParcelReceiving,
} from "@shared/returns/return-parcel-receiving.contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const pendingSchema = z
  .object({
    parcelId: z.number().int().positive().safe(),
    input: returnParcelReceiptInputSchema,
  })
  .strict();
const STORAGE_KEY = "return-parcel-pending-receipt-v1";
function restorePending(): {
  command: z.infer<typeof pendingSchema> | null;
  problem: string | null;
} {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    return {
      command: value ? pendingSchema.parse(JSON.parse(value)) : null,
      problem: null,
    };
  } catch {
    return {
      command: null,
      problem:
        "The saved box receipt could not be read. Review the return's receipt history with a supervisor before continuing in another browser session.",
    };
  }
}
class ReceiptRequestError extends Error {
  constructor(
    message: string,
    readonly definitelyRejected: boolean,
  ) {
    super(message);
  }
}
async function request<T extends z.ZodTypeAny>(
  url: string,
  schema: T,
  body?: unknown,
): Promise<z.infer<T>> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Return-Command": "1",
          },
          body: JSON.stringify(body),
        }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    const error = z
      .object({
        error: z.object({ code: z.string(), message: z.string().max(500) }),
      })
      .safeParse(result);
    const definitelyRejected =
      error.success &&
      [
        "RETURN_PARCEL_RECEIPT_STALE",
        "RETURN_PARCEL_RECEIPT_QUANTITY_INVALID",
        "RETURN_PARCEL_RECEIPT_RECONCILIATION_REQUIRED",
      ].includes(error.data.error.code);
    throw new ReceiptRequestError(
      error.success
        ? error.data.error.message
        : "The result could not be confirmed. Retry the same saved receipt.",
      definitelyRejected,
    );
  }
  return schema.parse(result);
}

export function ReturnParcelReceivingCard() {
  const [tracking, setTracking] = useState("");
  const [parcel, setParcel] = useState<ReturnParcelReceiving | null>(null);
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [restored] = useState(restorePending);
  const [pending, setPending] = useState(restored.command);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(restored.problem);
  const [message, setMessage] = useState<string | null>(null);
  async function lookup() {
    if (inFlight.current || pending || restored.problem) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    setParcel(null);
    try {
      const result = await request(
        `/api/returns/admin/receiving/label?trackingNumber=${encodeURIComponent(tracking.trim())}`,
        returnParcelReceivingSchema,
      );
      setParcel(result);
      setQuantities({});
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This return label could not be loaded.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function receive() {
    if (inFlight.current || restored.problem) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      let command = pending;
      if (!command) {
        if (!parcel) throw new Error("Scan a return label first.");
        const lines = parcel.lines.flatMap((line) => {
          const value = quantities[line.authorizationLineId]?.trim() ?? "";
          if (value === "" || value === "0") return [];
          if (!/^[1-9]\d*$/.test(value))
            throw new Error("Enter whole units received now.");
          const quantity = Number(value);
          if (
            !Number.isSafeInteger(quantity) ||
            quantity > line.expectedQuantity - line.receivedQuantity
          )
            throw new Error(
              "A received quantity exceeds the units still expected in this box.",
            );
          return [
            {
              authorizationLineId: line.authorizationLineId,
              expectedCurrentReceivedQuantity: line.receivedQuantity,
              quantityReceivedNow: quantity,
            },
          ];
        });
        if (lines.length === 0)
          throw new Error("Enter at least one unit received now.");
        command = pendingSchema.parse({
          parcelId: parcel.parcelId,
          input: { idempotencyKey: crypto.randomUUID(), notes: null, lines },
        });
        // Persist intent before dispatch. A lost response/reload must never mint
        // a second receipt key or silently alter the quantities being retried.
        try {
          sessionStorage.setItem(STORAGE_KEY, JSON.stringify(command));
        } catch {
          throw new Error(
            "Your browser could not save this receipt for recovery. No receipt was sent. Enable session storage before continuing.",
          );
        }
        setPending(command);
      }
      const result = await request(
        `/api/returns/admin/receiving/parcels/${command.parcelId}/receipt`,
        returnParcelReceiptResultSchema,
        command.input,
      );
      setParcel(result.parcel);
      setQuantities({});
      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {
        setMessage(
          "The saved box receipt is confirmed. No quantities were received twice.",
        );
        setError(
          "Your browser could not clear the saved receipt key. Keep this page open and contact a supervisor before recording another receipt.",
        );
        return;
      }
      setPending(null);
      setMessage(
        result.replayed
          ? "The saved box receipt is confirmed. No quantities were received twice."
          : "Box receipt recorded. Inspection and inventory treatment remain separate steps.",
      );
    } catch (cause) {
      if (cause instanceof ReceiptRequestError && cause.definitelyRejected) {
        // These errors are returned only after the entire DB transaction rolled
        // back. Re-scan to refresh the stale manifest; uncertain errors retain intent.
        try {
          sessionStorage.removeItem(STORAGE_KEY);
        } catch {
          setError(
            "The receipt was rejected, but its saved recovery key could not be cleared. Keep this page open and contact a supervisor.",
          );
          return;
        }
        setPending(null);
        setParcel(null);
        setQuantities({});
      }
      setError(
        cause instanceof Error
          ? cause.message
          : "The outcome could not be confirmed. Retry the same saved receipt.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Receive a return box</CardTitle>
        <p className="text-sm text-muted-foreground">
          Scan the return label, then count the items actually inside this box.
          Original shipment packing does not matter.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void lookup();
          }}
        >
          <div className="min-w-0 flex-1">
            <Label htmlFor="return-label-tracking">
              Return tracking number
            </Label>
            <Input
              id="return-label-tracking"
              value={tracking}
              onChange={(event) => setTracking(event.target.value)}
              disabled={busy || pending !== null || restored.problem !== null}
            />
          </div>
          <Button
            type="submit"
            disabled={
              busy ||
              pending !== null ||
              restored.problem !== null ||
              tracking.trim() === ""
            }
          >
            Find box
          </Button>
        </form>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        {pending && (
          <div className="space-y-2 rounded border p-3">
            <p>
              A receipt is awaiting confirmation for box {pending.parcelId}.
              Retry the saved quantities before receiving another box.
            </p>
            <Button disabled={busy} onClick={() => void receive()}>
              Retry saved receipt
            </Button>
          </div>
        )}
        {parcel && (
          <section className="space-y-3" aria-label="Return box contents">
            <h3 className="font-semibold">
              {parcel.authorizationNumber} · Box {parcel.boxNumber}
            </h3>
            <p className="text-sm text-muted-foreground">
              {parcel.trackingNumber}
            </p>
            {parcel.lines.map((line) => (
              <div
                key={line.authorizationLineId}
                className="flex flex-wrap items-center justify-between gap-3 border-b py-3"
              >
                <div>
                  <p>{line.title ?? "Purchased item"}</p>
                  <p className="text-sm text-muted-foreground">
                    {line.sku} · {line.receivedQuantity} of{" "}
                    {line.expectedQuantity} received
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Purchased line {line.authorizationLineId}
                  </p>
                </div>
                <div>
                  <Label htmlFor={`receive-line-${line.authorizationLineId}`}>
                    Units received now
                  </Label>
                  <Input
                    id={`receive-line-${line.authorizationLineId}`}
                    className="w-28"
                    inputMode="numeric"
                    value={quantities[line.authorizationLineId] ?? ""}
                    disabled={
                      busy ||
                      pending !== null ||
                      line.receivedQuantity === line.expectedQuantity
                    }
                    onChange={(event) =>
                      setQuantities((previous) => ({
                        ...previous,
                        [line.authorizationLineId]: event.target.value,
                      }))
                    }
                  />
                </div>
              </div>
            ))}
            <p className="text-sm text-muted-foreground">
              Recording receipt does not restock inventory or issue a refund.
            </p>
            {!pending && (
              <Button
                disabled={
                  busy ||
                  parcel.lines.every(
                    (line) => line.receivedQuantity === line.expectedQuantity,
                  )
                }
                onClick={() => void receive()}
              >
                Record box receipt
              </Button>
            )}
          </section>
        )}
      </CardContent>
    </Card>
  );
}
