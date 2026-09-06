import { Input } from "@/components/ui/input";
import { PACKING_LIST_FIELDS, type PackingListRow } from "@/lib/shipment-packing-list";

const coreFields = new Set(["sku", "qtyShipped", "cartonCount", "weightKg", "lengthCm", "widthCm", "heightCm"]);

export function PackingListPreview({ rows, errors, onChange }: {
  rows: PackingListRow[];
  errors: Array<{ row: number; error: string }>;
  onChange: (index: number, field: string, value: string) => void;
}) {
  const fields = PACKING_LIST_FIELDS.filter(({ field }) => coreFields.has(field) || rows.some((row) => row[field] !== undefined));
  const errorsByRow = new Map(errors.map((failure) => [failure.row, failure.error]));
  return (
    <div role="region" aria-label="Packing list rows" tabIndex={0} className="max-h-80 max-w-full min-w-0 overflow-auto rounded border">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th className="p-2">Data row</th>
            {fields.map(({ field, label }) => <th key={field} className="p-2 whitespace-nowrap">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td className="p-2 min-w-44">
                {index + 1}
                {errorsByRow.has(index + 1) && <p className="text-xs text-destructive">{errorsByRow.get(index + 1)}</p>}
              </td>
              {fields.map(({ field, label }) => (
                <td key={field} className="p-1">
                  <Input
                    aria-label={`Data row ${index + 1} ${label}`}
                    className="min-w-28"
                    value={String(row[field] ?? "")}
                    onChange={(event) => onChange(index, field, event.target.value)}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
