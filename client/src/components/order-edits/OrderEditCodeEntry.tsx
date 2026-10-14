import React, { useEffect, useId, useRef, useState } from "react";
import {
  orderEditCodeSchema,
  MAX_ORDER_EDIT_CODES,
  type OrderEditCodeApplication,
} from "@shared/order-edits/order-edit-codes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatOrderEditMoney } from "@/lib/order-edits";

export function OrderEditCodeEntry({
  codes,
  applications,
  disabled = false,
  available,
  onApply,
  onRemove,
  onEditing,
}: {
  codes: string[];
  applications: OrderEditCodeApplication[];
  disabled?: boolean;
  available: boolean;
  onApply(code: string): Promise<void>;
  onRemove(code: string): Promise<void> | void;
  onEditing?: (editing: boolean) => void;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    onEditing?.(pending || value.trim().length > 0);
  }, [pending, value, onEditing]);
  async function run(action: () => Promise<void> | void) {
    if (inFlight.current || disabled || !available) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This code could not be verified. Please try again.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  async function apply() {
    await run(async () => {
      const parsed = orderEditCodeSchema.safeParse(value);
      if (!parsed.success) throw new Error("Enter a coupon or rewards code.");
      const code = parsed.data.toUpperCase();
      if (codes.some((existing) => existing.toUpperCase() === code))
        throw new Error("This code has already been added.");
      if (codes.length >= MAX_ORDER_EDIT_CODES)
        throw new Error(`You can add up to ${MAX_ORDER_EDIT_CODES} codes.`);
      await onApply(code);
      setValue("");
    });
  }
  return (
    <section className="oe-code-entry" aria-labelledby={`${id}-label`}>
      <label id={`${id}-label`} htmlFor={id}>
        Coupon or rewards code
      </label>
      <div className="oe-code-entry-controls">
        <Input
          id={id}
          value={value}
          maxLength={255}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="Enter code"
          aria-describedby={error ? `${id}-error` : `${id}-help`}
          aria-invalid={error !== null}
          disabled={disabled || pending || !available}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void apply();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled || pending || !available || !value.trim()}
          onClick={() => void apply()}
        >
          {pending ? "Checking…" : "Apply code"}
        </Button>
      </div>
      <p id={`${id}-help`} className="oe-code-help">
        {available
          ? value.trim()
            ? "Apply this code or clear it before continuing."
            : "Eligible codes follow the same combination rules as checkout."
          : "Codes are temporarily unavailable. Your order has not changed."}
      </p>
      {codes.length > 0 && (
        <ul className="oe-code-list" aria-label="Codes added to your changes">
          {codes.map((code) => (
            <li key={code}>
              <span>{code}</span>
              {applications.find(
                (application) =>
                  application.code.toUpperCase() === code.toUpperCase(),
              )?.amountCents !== undefined && (
                <strong>
                  −
                  {formatOrderEditMoney(
                    applications.find(
                      (application) =>
                        application.code.toUpperCase() === code.toUpperCase(),
                    )!.amountCents,
                    "USD",
                  )}
                </strong>
              )}
              <button
                type="button"
                aria-label={`Remove ${code}`}
                disabled={disabled || pending || !available}
                onClick={() => void run(() => onRemove(code))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p id={`${id}-error`} className="oe-code-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
