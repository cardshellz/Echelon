import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { DropshipEbayStoreCategoryOption } from "@/lib/dropship-ops-surface";

/**
 * A searchable picker of the vendor's eBay store shelves ("Store categories").
 * The optional props let the Listing settings step use its own words (plan
 * 2A); left out, the picker reads exactly as it always has.
 */
export function EbayStoreCategoryCombobox({
  ariaLabel,
  categories,
  disabled = false,
  onValueChange,
  placeholder,
  value,
  hideIds = false,
  clearLabel = "Clear optional category",
  searchPlaceholder = "Search your eBay Store categories...",
  emptyMessage = "No matching Store categories.",
}: {
  ariaLabel: string;
  categories: readonly DropshipEbayStoreCategoryOption[];
  disabled?: boolean;
  onValueChange: (categoryId: string | null) => void;
  placeholder: string;
  value: string | null;
  /** Leaves out the "Store category <id>" line under each choice: vendors never see ids. */
  hideIds?: boolean;
  /** The choice that clears the value. */
  clearLabel?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selected = useMemo(
    () => categories.find((category) => category.categoryId === value) ?? null,
    [categories, value],
  );

  const close = () => {
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className="h-10 w-full min-w-52 justify-between gap-2 px-3 font-normal"
        >
          <span className={cn("min-w-0 truncate text-left", !selected && "text-muted-foreground")}>
            {selected?.path ?? placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={16}
        className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command shouldFilter>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder.replace(/\.+$/, "")}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
          <CommandList className="max-h-64 overflow-y-auto overscroll-contain">
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {value !== null && (
                <CommandItem
                  value="clear ebay store category selection"
                  onSelect={() => {
                    onValueChange(null);
                    close();
                  }}
                >
                  {clearLabel}
                </CommandItem>
              )}
              {categories.map((category) => (
                <CommandItem
                  key={category.categoryId}
                  value={`${category.path} ${category.categoryId}`}
                  onSelect={() => {
                    onValueChange(category.categoryId);
                    close();
                  }}
                  className="min-h-11"
                >
                  <Check
                    className={cn(
                      "h-4 w-4 shrink-0",
                      category.categoryId === value ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{category.path}</span>
                    {!hideIds && (
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        Store category {category.categoryId}
                      </span>
                    )}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
