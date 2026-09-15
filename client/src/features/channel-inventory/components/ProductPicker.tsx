import { useState } from "react";
import { Check, ChevronsUpDown, Package } from "lucide-react";

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

import { filterProducts, productLabel, type ProductSummary } from "../model";

const RESULT_LIMIT = 60;

/** Searchable product selector shared by the Selling rules and Quantities tabs. */
export function ProductPicker({ products, value, onChange, placeholder = "Choose a product", className, id }: {
  products: readonly ProductSummary[];
  value: number | null;
  onChange(productId: number): void;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = products.find((product) => product.id === value) ?? null;
  const results = filterProducts(products, query, RESULT_LIMIT);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("w-full justify-between font-normal", className)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Package className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className={cn("truncate", !selected && "text-muted-foreground")}>
              {selected ? productLabel(selected) : placeholder}
            </span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(28rem,90vw)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search by name or SKU" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>No products match this search.</CommandEmpty>
            <CommandGroup>
              {results.map((product) => (
                <CommandItem
                  key={product.id}
                  value={String(product.id)}
                  onSelect={() => { onChange(product.id); setOpen(false); setQuery(""); }}
                >
                  <Check className={cn("mr-2 h-4 w-4", product.id === value ? "opacity-100" : "opacity-0")} aria-hidden="true" />
                  <span className="truncate">{productLabel(product)}</span>
                </CommandItem>
              ))}
              {products.length > RESULT_LIMIT && results.length === RESULT_LIMIT && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Showing the first {RESULT_LIMIT}; keep typing to narrow.</p>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
