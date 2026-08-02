const SCROLL_EDGE_EPSILON_PX = 1;

export const APP_SCROLL_CONTAINER_SELECTOR = "main[data-app-scroll-container]";

export type VerticalScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function canScrollVertically(
  viewport: VerticalScrollMetrics,
  deltaY: number,
): boolean {
  if (!Number.isFinite(deltaY) || deltaY === 0) return false;

  if (deltaY < 0) {
    return viewport.scrollTop > SCROLL_EDGE_EPSILON_PX;
  }

  return (
    viewport.scrollTop + viewport.clientHeight <
    viewport.scrollHeight - SCROLL_EDGE_EPSILON_PX
  );
}

export function shouldChainQuoteWheelToPage(
  quoteViewport: VerticalScrollMetrics,
  pageViewport: VerticalScrollMetrics,
  deltaY: number,
): boolean {
  return (
    !canScrollVertically(quoteViewport, deltaY) &&
    canScrollVertically(pageViewport, deltaY)
  );
}
