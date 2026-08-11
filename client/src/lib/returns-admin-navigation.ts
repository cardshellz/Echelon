const LEGACY_DROPSHIP_RETURN_ROUTES: Record<string, string> = {
  returns: "/returns/cases",
  "return-policies": "/return-policies",
};

export function legacyDropshipReturnDestination(
  searchString: string,
): string | null {
  const normalizedSearch = searchString.startsWith("?")
    ? searchString.slice(1)
    : searchString;
  const tab = new URLSearchParams(normalizedSearch).get("tab");

  return tab ? LEGACY_DROPSHIP_RETURN_ROUTES[tab] ?? null : null;
}
