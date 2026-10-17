import { useCallback, useEffect, useState } from "react";
import { continuousLayoutCount } from "@/lib/layout";

/** Keep one ordered prefix, appending near the viewport only for very large maps. */
export function useContinuousLayout<T>(
  items: T[],
  large: boolean,
  batchSize: number,
  revealIndex = -1,
) {
  const [progress, setProgress] = useState({ items, count: batchSize });
  const [sentinel, sentinelRef] = useState<HTMLDivElement | null>(null);
  const requested = progress.items === items ? progress.count : batchSize;
  const visibleCount = continuousLayoutCount(
    items.length,
    large,
    requested,
    batchSize,
    revealIndex,
  );
  const hasMore = visibleCount < items.length;
  const loadMore = useCallback(() => {
    setProgress((previous) => ({
      items,
      count: Math.min(
        items.length,
        Math.max(previous.items === items ? previous.count : 0, visibleCount) +
          batchSize,
      ),
    }));
  }, [items, visibleCount, batchSize]);

  // Retain a revealed selection when it is cleared; scrolling never drops earlier rows.
  useEffect(() => {
    if (progress.items !== items || (large && visibleCount > requested)) {
      setProgress({ items, count: visibleCount });
    }
  }, [items, large, requested, visibleCount, progress.items]);

  useEffect(() => {
    if (!sentinel || !hasMore || typeof IntersectionObserver === "undefined")
      return;
    let requestedMore = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (requestedMore || !entries.some((entry) => entry.isIntersecting))
          return;
        requestedMore = true;
        loadMore();
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, hasMore, loadMore]);

  return { visibleCount, hasMore, loadMore, sentinelRef };
}
