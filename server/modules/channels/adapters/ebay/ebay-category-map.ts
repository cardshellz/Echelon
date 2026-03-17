/**
 * eBay Category Mapping for Card Shellz Products
 *
 * Maps internal product categories/types to eBay category IDs
 * and provides required item specifics per category.
 *
 * Category tree: Collectibles > Sports Memorabilia, Fan Shop & Sports Cards
 *   > Sports Trading Cards & Accessories > Storage & Display Supplies
 *
 * All category IDs are for the EBAY_US marketplace.
 */

// ---------------------------------------------------------------------------
// Category IDs
// ---------------------------------------------------------------------------

export const EBAY_CATEGORIES = {
  /** Parent: Sports Trading Card Storage & Display Supplies */
  STORAGE_DISPLAY_SUPPLIES: "183436",

  /** Card Toploaders & Holders */
  TOPLOADERS_HOLDERS: "183438",

  /** Card Sleeves & Bags */
  SLEEVES_BAGS: "183437",

  /** Albums, Binders & Pages */
  ALBUMS_BINDERS_PAGES: "183435",

  /** Card Storage Boxes & Dividers */
  STORAGE_BOXES_DIVIDERS: "183439",

  /** Card Display Cases & Stands */
  DISPLAY_CASES_STANDS: "183440",

  /** Card Sorting Trays */
  SORTING_TRAYS: "183441",
} as const;

// ---------------------------------------------------------------------------
// Product Type → Category Mapping
// ---------------------------------------------------------------------------

export interface CategoryMapping {
  categoryId: string;
  categoryName: string;
  /** Required and recommended item specifics for this category */
  defaultAspects: Record<string, string[]>;
  /** eBay condition ID (1000 = New) */
  conditionId: string;
}

/**
 * Maps internal product types/subcategories to eBay categories.
 * Key: lowercase product subcategory or type keyword.
 */
export const PRODUCT_TYPE_TO_CATEGORY: Record<string, CategoryMapping> = {
  // --- Toploaders ---
  toploader: {
    categoryId: EBAY_CATEGORIES.TOPLOADERS_HOLDERS,
    categoryName: "Card Toploaders & Holders",
    defaultAspects: {
      Type: ["Toploader"],
      "Compatible Card Size": ["Standard"],
      Material: ["PVC"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  // --- Magnetic Holders (One-Touch) ---
  "magnetic holder": {
    categoryId: EBAY_CATEGORIES.TOPLOADERS_HOLDERS,
    categoryName: "Card Toploaders & Holders",
    defaultAspects: {
      Type: ["Magnetic Holder"],
      "Compatible Card Size": ["Standard"],
      Features: ["UV Protection", "Magnetic Closure"],
      Material: ["Polycarbonate"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  "one-touch": {
    categoryId: EBAY_CATEGORIES.TOPLOADERS_HOLDERS,
    categoryName: "Card Toploaders & Holders",
    defaultAspects: {
      Type: ["Magnetic Holder"],
      "Compatible Card Size": ["Standard"],
      Features: ["UV Protection", "Magnetic Closure"],
      Material: ["Polycarbonate"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  // --- Semi-Rigid Holders ---
  "semi-rigid": {
    categoryId: EBAY_CATEGORIES.TOPLOADERS_HOLDERS,
    categoryName: "Card Toploaders & Holders",
    defaultAspects: {
      Type: ["Semi-Rigid Holder"],
      "Compatible Card Size": ["Standard"],
      Features: ["Flexible"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  "card saver": {
    categoryId: EBAY_CATEGORIES.TOPLOADERS_HOLDERS,
    categoryName: "Card Toploaders & Holders",
    defaultAspects: {
      Type: ["Semi-Rigid Holder"],
      "Compatible Card Size": ["Standard"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  // --- Penny Sleeves / Card Sleeves ---
  sleeve: {
    categoryId: EBAY_CATEGORIES.SLEEVES_BAGS,
    categoryName: "Card Sleeves & Bags",
    defaultAspects: {
      Type: ["Card Sleeves"],
      "Compatible Card Size": ["Standard"],
      Material: ["Polypropylene"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  "penny sleeve": {
    categoryId: EBAY_CATEGORIES.SLEEVES_BAGS,
    categoryName: "Card Sleeves & Bags",
    defaultAspects: {
      Type: ["Card Sleeves"],
      "Compatible Card Size": ["Standard"],
      Material: ["Polypropylene"],
      Features: ["Acid Free"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  "team bag": {
    categoryId: EBAY_CATEGORIES.SLEEVES_BAGS,
    categoryName: "Card Sleeves & Bags",
    defaultAspects: {
      Type: ["Team Bags"],
      Features: ["Resealable"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  // --- Binders & Pages ---
  binder: {
    categoryId: EBAY_CATEGORIES.ALBUMS_BINDERS_PAGES,
    categoryName: "Albums, Binders & Pages",
    defaultAspects: {
      Type: ["Binder"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  "pocket page": {
    categoryId: EBAY_CATEGORIES.ALBUMS_BINDERS_PAGES,
    categoryName: "Albums, Binders & Pages",
    defaultAspects: {
      Type: ["Pocket Pages"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  // --- Graded Card Cases ---
  "graded card case": {
    categoryId: EBAY_CATEGORIES.DISPLAY_CASES_STANDS,
    categoryName: "Card Display Cases & Stands",
    defaultAspects: {
      Type: ["Display Case"],
      Features: ["UV Protection"],
      "Compatible Card Size": ["Graded Card"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  "hero diamond": {
    categoryId: EBAY_CATEGORIES.DISPLAY_CASES_STANDS,
    categoryName: "Card Display Cases & Stands",
    defaultAspects: {
      Type: ["Display Case"],
      Features: ["UV Protection"],
      "Compatible Card Size": ["Graded Card"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  // --- Shipping Envelopes (Armalopes) ---
  armalope: {
    categoryId: EBAY_CATEGORIES.STORAGE_BOXES_DIVIDERS,
    categoryName: "Card Storage Boxes & Dividers",
    defaultAspects: {
      Type: ["Shipping Envelope"],
      Features: ["Rigid", "Protective"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  "shipping envelope": {
    categoryId: EBAY_CATEGORIES.STORAGE_BOXES_DIVIDERS,
    categoryName: "Card Storage Boxes & Dividers",
    defaultAspects: {
      Type: ["Shipping Envelope"],
      Features: ["Rigid", "Protective"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  // --- Storage Boxes ---
  "storage box": {
    categoryId: EBAY_CATEGORIES.STORAGE_BOXES_DIVIDERS,
    categoryName: "Card Storage Boxes & Dividers",
    defaultAspects: {
      Type: ["Card Storage Box"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  // --- Quad Box ---
  "quad box": {
    categoryId: EBAY_CATEGORIES.STORAGE_BOXES_DIVIDERS,
    categoryName: "Card Storage Boxes & Dividers",
    defaultAspects: {
      Type: ["Card Storage Box"],
      Features: ["USA Made"],
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },

  // --- Default fallback ---
  default: {
    categoryId: EBAY_CATEGORIES.STORAGE_DISPLAY_SUPPLIES,
    categoryName: "Storage & Display Supplies",
    defaultAspects: {
      Brand: ["Card Shellz"],
    },
    conditionId: "1000",
  },
};

// ---------------------------------------------------------------------------
// Lookup Functions
// ---------------------------------------------------------------------------

/**
 * Resolve eBay category mapping for a product.
 * Checks product subcategory, category, and name for keyword matches.
 *
 * @param product - Product data with category/subcategory/name
 * @returns Category mapping with eBay category ID and default item specifics
 */
export function resolveEbayCategoryMapping(product: {
  category?: string | null;
  subcategory?: string | null;
  name?: string | null;
}): CategoryMapping {
  // Try subcategory first (most specific)
  if (product.subcategory) {
    const subcat = product.subcategory.toLowerCase();
    for (const [key, mapping] of Object.entries(PRODUCT_TYPE_TO_CATEGORY)) {
      if (key !== "default" && subcat.includes(key)) {
        return mapping;
      }
    }
  }

  // Try category
  if (product.category) {
    const cat = product.category.toLowerCase();
    for (const [key, mapping] of Object.entries(PRODUCT_TYPE_TO_CATEGORY)) {
      if (key !== "default" && cat.includes(key)) {
        return mapping;
      }
    }
  }

  // Try product name
  if (product.name) {
    const name = product.name.toLowerCase();
    for (const [key, mapping] of Object.entries(PRODUCT_TYPE_TO_CATEGORY)) {
      if (key !== "default" && name.includes(key)) {
        return mapping;
      }
    }
  }

  return PRODUCT_TYPE_TO_CATEGORY.default;
}

/**
 * Build complete item specifics by merging:
 * 1. Category default aspects
 * 2. Product-level item specifics (from products.itemSpecifics)
 * 3. Channel-level overrides (from channel_product_overrides.itemSpecifics)
 *
 * Later sources override earlier ones for the same aspect name.
 */
export function buildItemSpecifics(
  categoryMapping: CategoryMapping,
  productItemSpecifics?: Record<string, string[]> | null,
  channelOverrides?: Record<string, string[]> | null,
): Record<string, string[]> {
  const aspects: Record<string, string[]> = { ...categoryMapping.defaultAspects };

  // Merge product-level specifics
  if (productItemSpecifics) {
    for (const [key, values] of Object.entries(productItemSpecifics)) {
      aspects[key] = values;
    }
  }

  // Merge channel-level overrides
  if (channelOverrides) {
    for (const [key, values] of Object.entries(channelOverrides)) {
      aspects[key] = values;
    }
  }

  return aspects;
}

/**
 * Map a carrier name to eBay's shipping carrier code.
 */
export function mapCarrierToEbay(carrier: string | null): string {
  if (!carrier) return "OTHER";

  const normalized = carrier.toUpperCase().trim();

  const CARRIER_MAP: Record<string, string> = {
    USPS: "USPS",
    "US POSTAL SERVICE": "USPS",
    UPS: "UPS",
    FEDEX: "FEDEX",
    "FEDERAL EXPRESS": "FEDEX",
    DHL: "DHL",
    "DHL EXPRESS": "DHL",
    AMAZON: "AMZN_US",
    "AMAZON LOGISTICS": "AMZN_US",
    ONTRAC: "ONTRAC",
    LASERSHIP: "LASERSHIP",
    "STAMPS.COM": "USPS",
    PIRATESHIP: "USPS",
    SHIPPO: "USPS",
    EASYPOST: "USPS",
  };

  return CARRIER_MAP[normalized] || "OTHER";
}
