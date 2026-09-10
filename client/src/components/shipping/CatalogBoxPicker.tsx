import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PackagingPolicyOverview } from "@shared/shipping/packaging-policy";

/** Shared picker: membership and availability commands own their selected IDs. */
export function CatalogBoxPicker({
  boxes,
  selected,
  onChange,
  allowInactive = false,
}: {
  boxes: PackagingPolicyOverview["boxes"];
  selected: number[];
  onChange: (ids: number[]) => void;
  allowInactive?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [branding, setBranding] = useState("all");
  const [page, setPage] = useState(0);
  const filtered = boxes.filter(
    (b) =>
      `${b.code} ${b.name}`.toLowerCase().includes(search.toLowerCase()) &&
      (branding === "all" || b.branding === branding),
  );
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(filtered.length / 25) - 1),
  );
  return (
    <div className="space-y-2">
      <Input
        aria-label="Search boxes"
        placeholder="Search code or name"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(0);
        }}
      />
      <div className="flex flex-wrap gap-2">
        <select
          aria-label="Box branding filter"
          className="border rounded h-9 px-2"
          value={branding}
          onChange={(e) => {
            setBranding(e.target.value);
            setPage(0);
          }}
        >
          <option value="all">All branding</option>
          <option value="unbranded">White label / unbranded</option>
          <option value="branded">Branded / graphics</option>
          <option value="unclassified">Not classified</option>
        </select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            !filtered.length ||
            new Set([...selected, ...filtered.map((b) => b.id)]).size > 1000
          }
          onClick={() =>
            onChange([
              ...new Set([
                ...selected,
                ...filtered
                  .filter((b) => allowInactive || b.isActive)
                  .map((b) => b.id),
              ]),
            ])
          }
        >
          Select all matching boxes
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onChange([])}
        >
          Clear boxes
        </Button>
      </div>
      <div className="max-h-64 overflow-auto border rounded p-2">
        {filtered.slice(current * 25, (current + 1) * 25).map((b) => (
          <label key={b.id} className="flex items-start gap-2 py-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={selected.includes(b.id)}
              disabled={
                !allowInactive && !b.isActive && !selected.includes(b.id)
              }
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, b.id]
                    : selected.filter((id) => id !== b.id),
                )
              }
            />
            <span>
              {b.code} · {b.name}
              <span className="block text-xs text-muted-foreground">
                {b.branding === "unbranded"
                  ? "White label / unbranded"
                  : b.branding === "branded"
                    ? "Branded / graphics"
                    : "Not classified"}
                {!b.isActive && " · Inactive"}
              </span>
            </span>
          </label>
        ))}
        {!filtered.length && <p>No matching boxes.</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span>
          {selected.length} selected · {filtered.length} matching · Page{" "}
          {current + 1}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!current}
          onClick={() => setPage(current - 1)}
        >
          Previous boxes
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={(current + 1) * 25 >= filtered.length}
          onClick={() => setPage(current + 1)}
        >
          Next boxes
        </Button>
      </div>
    </div>
  );
}
