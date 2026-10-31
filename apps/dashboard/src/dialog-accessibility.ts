import { icon } from "./view-utils.js";

export function renderSearchDialog(): string {
  return `<div class="search-backdrop" data-action="dismiss-search"></div><section class="search-dialog" role="dialog" aria-modal="true" aria-label="Search workspace" tabindex="-1"><div class="search-dialog-input">${icon("search", 19)}<label class="visually-hidden" for="workspace-search">Search bots and pages</label><input id="workspace-search" type="search" aria-controls="search-results" aria-describedby="search-hint" autocomplete="off" /><kbd>ESC</kbd></div><div class="search-results" id="search-results" aria-live="polite"></div><div class="search-hint" id="search-hint"><span>↑↓ to navigate</span><span>Enter to open</span><span>ESC to close</span></div></section>`;
}

export function nextSearchFocusIndex(
  currentIndex: number,
  resultCount: number,
  key: "ArrowUp" | "ArrowDown",
): number | undefined {
  if (resultCount < 1) return undefined;
  const direction = key === "ArrowDown" ? 1 : -1;
  if (currentIndex < 0 || currentIndex >= resultCount) return direction > 0 ? 0 : resultCount - 1;
  return (currentIndex + direction + resultCount) % resultCount;
}

/** Return the opposite dialog boundary only when Tab would leave the modal. */
export function dialogFocusWrapTarget(
  currentIndex: number,
  focusableCount: number,
  backwards: boolean,
): number | undefined {
  if (focusableCount < 1) return undefined;
  if (currentIndex < 0 || currentIndex >= focusableCount) return backwards ? focusableCount - 1 : 0;
  if (backwards && currentIndex === 0) return focusableCount - 1;
  if (!backwards && currentIndex === focusableCount - 1) return 0;
  return undefined;
}
