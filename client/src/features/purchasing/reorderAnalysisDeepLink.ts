export function reorderAnalysisSearchParams(
  routerLocation: string,
  browserSearch = typeof window === "undefined" ? "" : window.location.search,
): URLSearchParams {
  const queryIndex = routerLocation.indexOf("?");
  const query = queryIndex >= 0 ? routerLocation.slice(queryIndex + 1) : browserSearch;
  return new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
}
