import type {
  ListingDraftItem,
  ListingTaxonomy,
} from "@shared/types/channel-listing-publication";

export interface ProductTypeLeaf {
  key: string;
  productType: string;
  path: readonly string[];
  description: string | null;
}

export interface ProductTypeBranch {
  key: string;
  label: string;
  path: readonly string[];
  children: ProductTypeBranch[];
  leaves: ProductTypeLeaf[];
  productTypeCount: number;
}

export interface ProductTypeIndex {
  root: ProductTypeBranch;
  branches: ReadonlyMap<string, ProductTypeBranch>;
  leaves: readonly ProductTypeLeaf[];
  byType: ReadonlyMap<string, readonly ProductTypeLeaf[]>;
}

const compare = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;
const pathLabel = (leaf: ProductTypeLeaf): string =>
  [...leaf.path, leaf.productType].join(" > ");

/** Provider ancestry is data, never inferred from product names or local categories. */
export function buildProductTypeIndex(
  taxonomy: ListingTaxonomy,
): ProductTypeIndex {
  const allowed = new Set(taxonomy.productTypes);
  const leavesByKey = new Map<string, ProductTypeLeaf>();
  const represented = new Set<string>();
  for (const entry of taxonomy.entries) {
    if (!allowed.has(entry.productType)) continue;
    const key = JSON.stringify([entry.path, entry.productType]);
    if (leavesByKey.has(key)) continue;
    leavesByKey.set(key, { ...entry, path: [...entry.path], key });
    represented.add(entry.productType);
  }
  // Older or partial responses may lack ancestry. Keep those real leaves at
  // the root instead of inventing a category or discarding selectable types.
  for (const productType of allowed) {
    if (represented.has(productType)) continue;
    const key = JSON.stringify([[], productType]);
    leavesByKey.set(key, { key, productType, path: [], description: null });
  }
  const leaves = [...leavesByKey.values()].sort((left, right) =>
    compare(pathLabel(left), pathLabel(right)),
  );
  const branches = new Map<string, ProductTypeBranch>();
  const typesByBranch = new Map<string, Set<string>>();
  const byType = new Map<string, ProductTypeLeaf[]>();
  const root: ProductTypeBranch = {
    key: "[]",
    label: "",
    path: [],
    children: [],
    leaves: [],
    productTypeCount: allowed.size,
  };
  branches.set(root.key, root);
  for (const leaf of leaves) {
    const typeLeaves = byType.get(leaf.productType) ?? [];
    typeLeaves.push(leaf);
    byType.set(leaf.productType, typeLeaves);
    let branch = root;
    for (let depth = 0; depth < leaf.path.length; depth++) {
      const path = leaf.path.slice(0, depth + 1);
      const key = JSON.stringify(path);
      let child = branches.get(key);
      if (!child) {
        child = {
          key,
          label: path[depth],
          path,
          children: [],
          leaves: [],
          productTypeCount: 0,
        };
        branches.set(key, child);
        branch.children.push(child);
        typesByBranch.set(key, new Set());
      }
      typesByBranch.get(key)!.add(leaf.productType);
      child.productTypeCount = typesByBranch.get(key)!.size;
      branch = child;
    }
    branch.leaves.push(leaf);
  }
  for (const branch of branches.values()) {
    branch.children.sort((left, right) => compare(left.label, right.label));
    branch.leaves.sort((left, right) =>
      compare(left.productType, right.productType),
    );
  }
  return { root, branches, leaves, byType };
}

/** Search leaf names and actual ancestry together; tokens are case-insensitive. */
export function searchProductTypes(
  index: ProductTypeIndex,
  query: string,
): readonly ProductTypeLeaf[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return index.leaves;
  return index.leaves.filter((leaf) => {
    const searchable = pathLabel(leaf).toLowerCase();
    return tokens.every((token) => searchable.includes(token));
  });
}

/** Browsing never calls this. Re-selecting the saved leaf preserves all edits. */
export function selectListingProductType(
  current: ListingDraftItem,
  productType: string,
  taxonomy: ListingTaxonomy,
): ListingDraftItem {
  if (!taxonomy.productTypes.includes(productType))
    throw new Error("Choose an available product type from the list.");
  return productType === current.productType
    ? current
    : { ...current, productType, attributes: {} };
}
