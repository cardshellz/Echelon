import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PoLineQuoteMetadataDraft = {
  quoteReference: string;
  quotedAt: string;
  quoteValidUntil: string;
};

export type PoLineQuoteMetadataPayload = {
  quoteReference: string | null;
  quotedAt: string | null;
  quoteValidUntil: string | null;
};

export type PopulatedPoLineQuoteMetadata = {
  quoteReference?: string;
  quotedAt?: string;
  quoteValidUntil?: string;
};

export type PoLineQuoteMetadataEvaluation = {
  metadata: PoLineQuoteMetadataPayload | null;
  error: string | null;
};

/**
 * New-line/create payloads omit empty metadata instead of asserting nulls.
 * Update flows that need to clear a stored value should use the full payload.
 */
export function populatedPoLineQuoteMetadata(
  metadata: PoLineQuoteMetadataPayload,
): PopulatedPoLineQuoteMetadata {
  return {
    ...(metadata.quoteReference !== null
      ? { quoteReference: metadata.quoteReference }
      : {}),
    ...(metadata.quotedAt !== null ? { quotedAt: metadata.quotedAt } : {}),
    ...(metadata.quoteValidUntil !== null
      ? { quoteValidUntil: metadata.quoteValidUntil }
      : {}),
  };
}

/** Reusable catalog automation requires a dated supplier quote. */
export function reusableCatalogQuoteDateMissing(
  saveToVendorCatalog: boolean,
  pricingBasis: string,
  metadata: PoLineQuoteMetadataPayload | null,
): boolean {
  return saveToVendorCatalog &&
    pricingBasis !== "extended_total" &&
    metadata !== null &&
    metadata.quotedAt === null;
}

/** Build a PATCH containing only fields whose visible editor value changed. */
export function changedPoLineQuoteMetadata(
  original: PoLineQuoteMetadataDraft,
  current: PoLineQuoteMetadataDraft,
  normalized: PoLineQuoteMetadataPayload,
): Partial<PoLineQuoteMetadataPayload> {
  return {
    ...(original.quoteReference !== current.quoteReference
      ? { quoteReference: normalized.quoteReference }
      : {}),
    ...(original.quotedAt !== current.quotedAt
      ? { quotedAt: normalized.quotedAt }
      : {}),
    ...(original.quoteValidUntil !== current.quoteValidUntil
      ? { quoteValidUntil: normalized.quoteValidUntil }
      : {}),
  };
}

export function createEmptyPoLineQuoteMetadataDraft(
  initial?: Partial<PoLineQuoteMetadataDraft>,
): PoLineQuoteMetadataDraft {
  return {
    quoteReference: "",
    quotedAt: "",
    quoteValidUntil: "",
    ...initial,
  };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function storedDateInputValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const candidate = String(value).slice(0, 10);
  return isCalendarDate(candidate) ? candidate : "";
}

export function createPoLineQuoteMetadataDraftFromStored(
  line: {
    quoteReference?: unknown;
    quotedAt?: unknown;
    quoteValidUntil?: unknown;
  },
): PoLineQuoteMetadataDraft {
  return createEmptyPoLineQuoteMetadataDraft({
    quoteReference:
      typeof line.quoteReference === "string" ? line.quoteReference : "",
    quotedAt: storedDateInputValue(line.quotedAt),
    quoteValidUntil: storedDateInputValue(line.quoteValidUntil),
  });
}

export function evaluatePoLineQuoteMetadataDraft(
  draft: PoLineQuoteMetadataDraft,
): PoLineQuoteMetadataEvaluation {
  const reference = draft.quoteReference.trim();
  if (reference.length > 255) {
    return {
      metadata: null,
      error: "Quote reference must be 255 characters or fewer.",
    };
  }
  if (draft.quotedAt && !isCalendarDate(draft.quotedAt)) {
    return { metadata: null, error: "Quote date must be a valid date." };
  }
  if (draft.quoteValidUntil && !isCalendarDate(draft.quoteValidUntil)) {
    return { metadata: null, error: "Valid-until date must be a valid date." };
  }
  if (
    draft.quotedAt &&
    draft.quoteValidUntil &&
    draft.quoteValidUntil < draft.quotedAt
  ) {
    return {
      metadata: null,
      error: "Valid-until date must be on or after the quote date.",
    };
  }

  return {
    metadata: {
      quoteReference: reference || null,
      quotedAt: draft.quotedAt || null,
      quoteValidUntil: draft.quoteValidUntil || null,
    },
    error: null,
  };
}

export function PoLineQuoteMetadataEditor({
  value,
  onChange,
  className = "",
}: {
  value: PoLineQuoteMetadataDraft;
  onChange: (next: PoLineQuoteMetadataDraft) => void;
  className?: string;
}) {
  const evaluation = evaluatePoLineQuoteMetadataDraft(value);
  const set = <K extends keyof PoLineQuoteMetadataDraft>(
    key: K,
    next: PoLineQuoteMetadataDraft[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <div className={`rounded-md border p-3 space-y-3 ${className}`}>
      <div>
        <div className="text-sm font-medium">Quote details (optional)</div>
        <p className="text-xs text-muted-foreground">
          Keep the supplier's reference and validity dates with the original quote.
          A quote date is required only when saving this price for reusable catalog automation.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-2 sm:col-span-3">
          <Label>Vendor quote reference</Label>
          <Input
            value={value.quoteReference}
            maxLength={255}
            onChange={(event) => set("quoteReference", event.target.value)}
            placeholder="Quote number, email subject, or RFQ reference"
          />
          <p className="text-xs text-muted-foreground text-right">
            {value.quoteReference.length}/255
          </p>
        </div>
        <div className="space-y-2">
          <Label>Quote date</Label>
          <Input
            type="date"
            value={value.quotedAt}
            onChange={(event) => set("quotedAt", event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Valid until</Label>
          <Input
            type="date"
            value={value.quoteValidUntil}
            onChange={(event) => set("quoteValidUntil", event.target.value)}
          />
        </div>
      </div>
      {evaluation.error && (
        <p className="text-xs text-amber-700" aria-live="polite">
          {evaluation.error}
        </p>
      )}
    </div>
  );
}
