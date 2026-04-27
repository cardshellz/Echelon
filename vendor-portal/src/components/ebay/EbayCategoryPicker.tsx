/**
 * eBay Browse Category Picker
 *
 * Hybrid browsable tree + search picker for eBay categories.
 * Browse mode: drill into category tree with breadcrumb navigation.
 * Search mode: type-ahead search via Taxonomy API suggestions.
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
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Pencil,
  Search,
  Loader2,
  XCircle,
  ChevronRight,
  ArrowLeft,
  Check,
} from "lucide-react";

// ============================================================================
// Types
// ============================================================================

interface CategorySuggestion {
  categoryId: string;
  categoryName: string;
  breadcrumb: string;
}

interface TreeCategory {
  categoryId: string;
  categoryName: string;
  hasChildren: boolean;
  parentId?: string;
  breadcrumb?: string;
}

interface PathSegment {
  categoryId: string;
  categoryName: string;
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

  // Search state
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CategorySuggestion[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Browse state
  const [currentPath, setCurrentPath] = useState<PathSegment[]>([]);
  const [currentChildren, setCurrentChildren] = useState<TreeCategory[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  // ---- Browse: fetch root categories ----
  const fetchRootCategories = useCallback(async () => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const resp = await fetch("/api/ebay/category-tree", {
        credentials: "include",
      });
      if (resp.ok) {
        const data = await resp.json();
        setCurrentChildren(data.categories || []);
      } else {
        setBrowseError("Failed to load categories");
        setCurrentChildren([]);
      }
    } catch {
      setBrowseError("Failed to load categories");
      setCurrentChildren([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  // ---- Browse: fetch children of a category ----
  const fetchChildren = useCallback(async (categoryId: string) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const resp = await fetch(
        `/api/ebay/category-tree/${encodeURIComponent(categoryId)}/children`,
        { credentials: "include" }
      );
      if (resp.ok) {
        const data = await resp.json();
        setCurrentChildren(data.categories || []);
      } else {
        setBrowseError("Failed to load subcategories");
        setCurrentChildren([]);
      }
    } catch {
      setBrowseError("Failed to load subcategories");
      setCurrentChildren([]);
    } finally {
      setBrowseLoading(false);
    }
  }, []);

  // ---- Load root on open ----
  useEffect(() => {
    if (open && currentPath.length === 0 && currentChildren.length === 0) {
      fetchRootCategories();
    }
  }, [open, currentPath.length, currentChildren.length, fetchRootCategories]);

  // ---- Search ----
  const search = useCallback(async (q: string) => {
    if (q.length < 2) {
      setSearchResults([]);
      setSearched(false);
      return;
    }
    setSearchLoading(true);
    setSearched(true);
    try {
      const resp = await fetch(
        `/api/ebay/category-search?q=${encodeURIComponent(q)}`,
        { credentials: "include" }
      );
      if (resp.ok) {
        const data = await resp.json();
        setSearchResults(data.categories || []);
      } else {
        setSearchResults([]);
      }
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (value.trim().length === 0) {
        setSearchResults([]);
        setSearched(false);
        return;
      }
      debounceRef.current = setTimeout(() => search(value), 300);
    },
    [search]
  );

  // ---- Browse: drill into a category ----
  const handleDrillIn = useCallback(
    (cat: TreeCategory) => {
      setCurrentPath((prev) => {
        // Prevent duplicate: don't add if already the last item
        if (prev.length > 0 && prev[prev.length - 1].categoryId === cat.categoryId) {
          return prev;
        }
        return [
          ...prev,
          { categoryId: cat.categoryId, categoryName: cat.categoryName },
        ];
      });
      fetchChildren(cat.categoryId);
    },
    [fetchChildren]
  );

  // ---- Browse: click breadcrumb to jump to a level ----
  const handleBreadcrumbClick = useCallback(
    (index: number) => {
      if (index < 0) {
        // Go to root
        setCurrentPath([]);
        fetchRootCategories();
      } else {
        const newPath = currentPath.slice(0, index + 1);
        setCurrentPath(newPath);
        fetchChildren(newPath[newPath.length - 1].categoryId);
      }
    },
    [currentPath, fetchChildren, fetchRootCategories]
  );

  // ---- Go up one level ----
  const handleGoUp = useCallback(() => {
    if (currentPath.length <= 1) {
      setCurrentPath([]);
      fetchRootCategories();
    } else {
      const newPath = currentPath.slice(0, -1);
      setCurrentPath(newPath);
      fetchChildren(newPath[newPath.length - 1].categoryId);
    }
  }, [currentPath, fetchChildren, fetchRootCategories]);

  // ---- Select a category ----
  const handleSelect = useCallback(
    (categoryId: string, categoryName: string) => {
      onSelect(categoryId, categoryName);
      setOpen(false);
      setQuery("");
      setSearchResults([]);
      setSearched(false);
    },
    [onSelect]
  );

  // ---- Clear selection ----
  const handleClear = useCallback(() => {
    onSelect(null, null);
    setOpen(false);
    setQuery("");
    setSearchResults([]);
    setSearched(false);
  }, [onSelect]);

  // ---- Dialog open/close ----
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      setOpen(isOpen);
      if (!isOpen) {
        setQuery("");
        setSearchResults([]);
        setSearched(false);
        // Keep browse state so reopening stays at same level
      }
    },
    []
  );

  const isSearchMode = query.trim().length > 0;

  // ---- Trigger button ----
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
      Browse categories...
    </Button>
  );

  return (
    <>
      {triggerButton}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[520px] h-[85vh] sm:h-[70vh] sm:max-h-[600px] flex flex-col p-4 overflow-hidden">
          <DialogHeader>
            <DialogTitle className="text-base">
              Select eBay Category
            </DialogTitle>
          </DialogHeader>

          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search eBay categories..."
              className="pl-9 pr-8"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              autoFocus
            />
            {(searchLoading || browseLoading) && (
              <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          {/* Breadcrumb bar */}
          <div className="flex items-center gap-1 min-h-[28px]">
            {currentPath.length > 0 && (
              <button
                onClick={handleGoUp}
                className="shrink-0 p-1 rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                title="Go up one level"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
              </button>
            )}
            <Breadcrumb className="overflow-hidden">
              <BreadcrumbList className="flex-nowrap overflow-x-auto text-xs">
                <BreadcrumbItem>
                  {currentPath.length === 0 ? (
                    <BreadcrumbPage className="font-semibold text-xs">
                      All Categories
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      className="cursor-pointer text-xs"
                      onClick={() => handleBreadcrumbClick(-1)}
                    >
                      All Categories
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {currentPath.map((seg, i) => {
                  const isLast = i === currentPath.length - 1;
                  return (
                    <React.Fragment key={seg.categoryId}>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        {isLast ? (
                          <BreadcrumbPage className="font-semibold text-xs truncate max-w-[140px]">
                            {seg.categoryName}
                          </BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink
                            className="cursor-pointer text-xs truncate max-w-[140px]"
                            onClick={() => handleBreadcrumbClick(i)}
                          >
                            {seg.categoryName}
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                    </React.Fragment>
                  );
                })}
              </BreadcrumbList>
            </Breadcrumb>
          </div>

          {/* Scrollable content */}
          <ScrollArea className="flex-1 min-h-0">
            {/* Clear category button */}
            {currentCategoryId && (
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors flex items-center gap-2 text-destructive"
                onClick={handleClear}
              >
                <XCircle className="h-3.5 w-3.5" />
                Clear category
              </button>
            )}

            {/* Search mode */}
            {isSearchMode && (
              <>
                {searchResults.map((cat) => (
                  <button
                    key={cat.categoryId}
                    className="w-full text-left px-3 py-2.5 text-sm hover:bg-accent transition-colors border-b border-border/40 last:border-0"
                    onClick={() =>
                      handleSelect(cat.categoryId, cat.categoryName)
                    }
                  >
                    <div className="font-medium text-sm">
                      {cat.categoryName}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 break-words whitespace-normal">
                      {cat.breadcrumb}
                    </div>
                  </button>
                ))}

                {searched && !searchLoading && searchResults.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No categories found
                  </div>
                )}

                {!searched && !searchLoading && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    Type at least 2 characters to search
                  </div>
                )}
              </>
            )}

            {/* Browse mode */}
            {!isSearchMode && (
              <>
                {browseError && (
                  <div className="px-3 py-6 text-center text-sm text-destructive">
                    {browseError}
                  </div>
                )}

                {!browseLoading && !browseError && currentChildren.length === 0 && (
                  <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                    No subcategories
                  </div>
                )}

                {currentChildren.map((cat) => (
                  <div
                    key={cat.categoryId}
                    className="flex items-center border-b border-border/40 last:border-0"
                  >
                    {/* Main row: drill in or select */}
                    <button
                      className="flex-1 text-left px-3 py-2.5 text-sm hover:bg-accent transition-colors flex items-center justify-between gap-2"
                      onClick={() => {
                        if (cat.hasChildren) {
                          handleDrillIn(cat);
                        } else {
                          handleSelect(cat.categoryId, cat.categoryName);
                        }
                      }}
                    >
                      <span className="font-medium text-sm">
                        {cat.categoryName}
                      </span>
                      {cat.hasChildren && (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                    </button>

                    {/* Select button for parent categories */}
                    {cat.hasChildren && (
                      <button
                        className="shrink-0 px-2.5 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors border-l border-border/40 flex items-center gap-1"
                        onClick={() =>
                          handleSelect(cat.categoryId, cat.categoryName)
                        }
                        title={`Select "${cat.categoryName}"`}
                      >
                        <Check className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline">Select</span>
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
