import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CustomerReturnFlowOrder } from "@shared/returns/customer-return-flow.contract";
import {
  customPreviewParcelSize,
  formatPreviewDimensions,
  previewParcelProductWeight,
  type PreviewParcelDraft,
} from "@/lib/customer-return-parcels";

const dimensionFields = [
  { key: "lengthInches", label: "Length" },
  { key: "widthInches", label: "Width" },
  { key: "heightInches", label: "Height" },
] as const;

export function CustomerReturnParcelDetails({
  order,
  parcel,
  boxNumber,
  busy,
  onChange,
}: {
  order: CustomerReturnFlowOrder;
  parcel: PreviewParcelDraft;
  boxNumber: number;
  busy: boolean;
  onChange: (parcel: PreviewParcelDraft) => void;
}) {
  const weight = previewParcelProductWeight(order, parcel);
  const originalBoxId =
    parcel.size.kind === "original" ? parcel.size.originalBoxId : null;
  const original = order.boxOptions.find(
    (option) => option.id === originalBoxId,
  );
  const sizeId = `return-box-${parcel.key}-size`;
  return (
    <div className="mb-4 space-y-3 border-b pb-4">
      {weight.status === "unverified" && (
        <p className="text-sm text-muted-foreground">
          We cannot prepare this box for return yet. Please contact support for
          help.
        </p>
      )}
      {original && parcel.size.kind === "original" ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">Using your original shipping box</p>
            <p className="text-sm">{formatPreviewDimensions(original.dimensions)}</p>
            <p className="text-xs text-muted-foreground">Reusing that box? You’re ready to continue. Using another box? Change its size below.</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="min-h-11"
            disabled={busy}
            aria-label={`Change size for box ${boxNumber}`}
            onClick={() =>
              onChange({
                ...parcel,
                size: customPreviewParcelSize(original.dimensions),
              })
            }
          >
            Change box
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {order.boxOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor={sizeId}>Box size</Label>
              <select
                id={sizeId}
                aria-label={`Box size for box ${boxNumber}`}
                className="min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                disabled={busy}
                value={parcel.size.kind === "custom" ? "custom" : ""}
                onChange={(event) => {
                  const source = order.boxOptions.find(
                    (option) => `original:${option.id}` === event.target.value,
                  );
                  onChange({
                    ...parcel,
                    size: source
                      ? {
                          kind: "original",
                          originalBoxId: source.id,
                          automatic: false,
                        }
                      : event.target.value === "custom"
                        ? customPreviewParcelSize()
                        : { kind: "unselected" },
                  });
                }}
              >
                <option value="">Choose a box size</option>
                {order.boxOptions.map((option, index) => (
                  <option key={option.id} value={`original:${option.id}`}>
                    Original box {index + 1} ·{" "}
                    {formatPreviewDimensions(option.dimensions)}
                  </option>
                ))}
                <option value="custom">Use a different box</option>
              </select>
            </div>
          )}
          {parcel.size.kind === "custom" && (
            <fieldset className="min-w-0 space-y-2">
              <legend className="text-sm font-medium">
                Box dimensions (inches)
              </legend>
              {order.boxOptions.length === 0 && !parcel.size.originalDimensions && (
                <p className="text-sm text-muted-foreground">We don’t have verified dimensions for your original shipping box. Enter the size of the box you’ll use.</p>
              )}
              <div className="grid grid-cols-3 gap-2">
                {dimensionFields.map((field) => {
                  const fieldId = `return-box-${parcel.key}-${field.key}`;
                  return (
                    <div key={field.key} className="min-w-0 space-y-1.5">
                      <Label htmlFor={fieldId} className="text-xs">
                        {field.label}
                      </Label>
                      <Input
                        id={fieldId}
                        type="text"
                        inputMode="decimal"
                        maxLength={20}
                        aria-label={`${field.label} of box ${boxNumber} in inches`}
                        className="min-h-11 min-w-0"
                        disabled={busy}
                        value={
                          parcel.size.kind === "custom"
                            ? parcel.size[field.key]
                            : ""
                        }
                        onChange={(event) => {
                          if (parcel.size.kind !== "custom") return;
                          onChange({
                            ...parcel,
                            size: {
                              ...parcel.size,
                              [field.key]: event.target.value,
                            },
                          });
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Measure the outside of your packed box.
              </p>
            </fieldset>
          )}
        </div>
      )}
    </div>
  );
}
