/**
 * eBay Browse Category Picker
 *
 * Interactive search-and-select for eBay browse categories using the Taxonomy API.
 * Desktop: Popover with search. Mobile: Full-screen dialog/sheet.
 */

import React, { useState, useCallback, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Pencil, Search, Loader2, XCircle } from "lucide-react";

// ============================================================================
// Types
// ============================================================================

interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  breadcrumb: string;
}

interface EbayCategoryPickerProps {
  currentCategoryId: string | null;
  currentCategoryName: string | null;
  onSelect: (categoryId: string | null, categoryName: string | null) => void;
}

// ============================================================================
// Component
// ============================================================================

export function EbayCategoryPicker({
  currentCategoryId,
  currentCategoryName,
  onSelect,
}: EbayCategoryPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CategorySuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMobile = useIsMobile();

  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setResults([]);
      setSearched(false);
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const resp = await fetch(
        `/api/ebay/category-search?q=${encodeURIComponent(q)}`,
        { credentials: "include" }
      );
      if (resp.ok) {
        const data = await resp.json();
        setResults(data.categories || []);
      } else {
        setResults([]);
      }
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value), 300);
  };

  const handleSelect = (cat: CategorySuggestion) => {
    onSelect(cat.categoryId, cat.categoryName);
    setOpen(false);
    setQuery("");
    setResults([]);
    setSearched(false);
  };

  const handleClear = () => {
    onSelect(null, null);
    setOpen(false);
    setQuery("");
    setResults([]);
    setSearched(false);
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      setQuery("");
      setResults([]);
      setSearched(false);
    }
  };

  // Shared search content
  const searchContent = (
    <div className="flex flex-col h-full">
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search eBay categories..."
          className="pl-9 pr-8"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          autoFocus
        />
        {loading && (
          <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      <ScrollArea className="flex-1 mt-2" style={{ maxHeight: "280px" }}>
        {currentCategoryId && (
          <button
            className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center gap-2 text-destructive"
            onClick={handleClear}
          >
            <XCircle className="h-3.5 w-3.5" />
            Clear category
          </button>
        )}

        {results.map((cat) => (
          <button
            key={cat.categoryId}
            className="w-full text-left px-3 py-2.5 text-sm hover:bg-accent transition-colors border-b border-border/40 last:border-0"
            onClick={() => handleSelect(cat)}
          >
            <div className="font-medium text-sm">{cat.categoryName}</div>
            <div className="text-xs text-muted-foreground mt-0.5 break-words whitespace-normal">
              {cat.breadcrumb}
            </div>
          </button>
        ))}

        {searched && !loading && results.length === 0 && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No categories found
          </div>
        )}

        {!searched && !loading && (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            Type at least 2 characters to search
          </div>
        )}
      </ScrollArea>
    </div>
  );

  // Shared trigger button
  const triggerButton = currentCategoryName ? (
    <Button
      variant="outline"
      size="sm"
      className="h-auto min-h-[32px] text-xs gap-1.5 max-w-full text-left justify-start py-1"
      onClick={() => setOpen(true)}
    >
      <Pencil className="h-3 w-3 shrink-0" />
      <span className="truncate">{currentCategoryName}</span>
    </Button>
  ) : (
    <Button
      variant="outline"
      size="sm"
      className="h-8 text-xs gap-1.5"
      onClick={() => setOpen(true)}
    >
      <Search className="h-3.5 w-3.5" />
      Search categories...
    </Button>
  );

  return (
    <>
      {triggerButton}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[480px] h-[85vh] sm:h-auto sm:max-h-[500px] flex flex-col p-4">
          <DialogHeader>
            <DialogTitle className="text-base">Select eBay Category</DialogTitle>
          </DialogHeader>
          {searchContent}
        </DialogContent>
      </Dialog>
    </>
  );
}
