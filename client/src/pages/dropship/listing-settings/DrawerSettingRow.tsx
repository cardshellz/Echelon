import type { DrawerSettingRowModel } from "@/lib/dropship-listing-settings-drawer";

/**
 * One read-only row of the product drawer (R:259-266): SHIPPING POLICY,
 * RETURN POLICY, PAYMENT POLICY, EBAY CATEGORY, STORE SHELF or DESCRIPTION,
 * with each value and where it comes from (C17). When the sizes differ, each
 * value is listed with the sizes that use it (C16). Nothing here can be
 * changed in PR 7: product values arrive with W5 (PRs 9-10), so there is no
 * button.
 */
export function DrawerSettingRow({ row }: { row: DrawerSettingRowModel }) {
  return (
    <div
      className="grid gap-1 border-t border-zinc-100 py-3 first:border-t-0 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4"
      data-testid={`drawer-setting-${row.key}`}
    >
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{row.label}</h4>
      <div className="min-w-0 space-y-2">
        {row.groups.map((group, groupIndex) => (
          <div key={groupIndex} className="space-y-1">
            {group.differ && (
              <p className="text-sm font-medium text-amber-900">
                <span aria-hidden="true">! </span>{group.differ}
              </p>
            )}
            <ul className="space-y-1">
              {group.entries.map((entry, entryIndex) => (
                <li key={entryIndex} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <span className="break-words text-zinc-900">{entry.value}</span>
                  {entry.tags.map((tag) => (
                    <span key={tag} className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700">{tag}</span>
                  ))}
                  {entry.usedBy && <span className="text-xs text-zinc-600">{entry.usedBy}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {row.notes.map((note) => <p key={note} className="text-xs text-zinc-600">{note}</p>)}
      </div>
    </div>
  );
}
