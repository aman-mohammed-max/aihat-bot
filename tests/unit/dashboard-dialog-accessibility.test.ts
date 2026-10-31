import { describe, expect, test } from "bun:test";
import {
  dialogFocusWrapTarget,
  nextSearchFocusIndex,
  renderSearchDialog,
} from "../../apps/dashboard/src/dialog-accessibility.js";

describe("dashboard dialog accessibility", () => {
  test("search dialog exposes a named, described search field and live results", () => {
    const markup = renderSearchDialog();
    expect(markup).toContain('role="dialog" aria-modal="true"');
    expect(markup).toContain('aria-label="Search workspace"');
    expect(markup).toContain('<label class="visually-hidden" for="workspace-search">Search bots and pages</label>');
    expect(markup).toContain('aria-controls="search-results" aria-describedby="search-hint"');
    expect(markup).toContain('id="search-results" aria-live="polite"');
  });

  test("arrow keys navigate and wrap the search result buttons", () => {
    expect(nextSearchFocusIndex(-1, 3, "ArrowDown")).toBe(0);
    expect(nextSearchFocusIndex(-1, 3, "ArrowUp")).toBe(2);
    expect(nextSearchFocusIndex(0, 3, "ArrowUp")).toBe(2);
    expect(nextSearchFocusIndex(2, 3, "ArrowDown")).toBe(0);
    expect(nextSearchFocusIndex(1, 3, "ArrowDown")).toBe(2);
    expect(nextSearchFocusIndex(0, 0, "ArrowDown")).toBeUndefined();
  });

  test("Tab focus wraps only at dialog boundaries", () => {
    expect(dialogFocusWrapTarget(0, 2, true)).toBe(1);
    expect(dialogFocusWrapTarget(1, 2, false)).toBe(0);
    expect(dialogFocusWrapTarget(1, 2, true)).toBeUndefined();
    expect(dialogFocusWrapTarget(-1, 2, false)).toBe(0);
    expect(dialogFocusWrapTarget(-1, 2, true)).toBe(1);
    expect(dialogFocusWrapTarget(0, 0, false)).toBeUndefined();
  });
});
