export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character] ?? character;
  });
}

export function icon(name: string, size = 18): string {
  const paths: Record<string, string> = {
    home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
    bots: '<rect x="4" y="7" width="16" height="13" rx="4"/><path d="M12 3v4m-4 6h.01M16 13h.01M9 17h6"/><path d="M2 12h2m16 0h2"/>',
    spark:
      '<path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-2-5.8L4 11l6-2.2z"/><path d="m19 14 1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2z"/>',
    plug: '<path d="M8 7V3m8 4V3M7 7h10v5a5 5 0 0 1-10 0zM12 17v4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 2 2-3 3-2-2-2 2"/>',
    shield: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11"/><path d="m9 12 2 2 4-4"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14m-7-7 7 7-7 7"/>',
    chevron: '<path d="m9 18 6-6-6-6"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    botfather:
      '<path d="M4 8a8 8 0 1 1 16 0v8a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M8 12h.01M16 12h.01M9 16h6M12 3V1"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    external: '<path d="M14 3h7v7m0-7-9 9"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    chat: '<path d="M21 11.5a8.5 8.5 0 0 1-9 8.5 9.4 9.4 0 0 1-4-.9L3 21l1.9-4.5a8.2 8.2 0 0 1-1.4-5A8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5Z"/>',
    chart: '<path d="M4 19V5m0 14h17"/><path d="m7 15 4-4 3 3 6-7"/>',
    dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.4.8l-.3 1.8h-2.8L13 18.8a8 8 0 0 1-1.6 0l-.4 1.8H8.2l-.3-1.8a8 8 0 0 1-1.4-.8l-1.7.6-1.4-2.4 1.4-1.1a8 8 0 0 1-.2-1.6l-1.6-.9 1-2.6 1.8.2a8 8 0 0 1 1-1.2L6.4 7.3 8.9 6l1.3 1.3a8 8 0 0 1 1.6-.3l.6-1.7h2.8l.6 1.7a8 8 0 0 1 1.6.3L18.7 6l2.5 1.3-.8 1.7a8 8 0 0 1 1 1.2l1.8-.2 1 2.6-1.6.9a8 8 0 0 1-.2 1.5Z"/>',
    logout: '<path d="M10 17l5-5-5-5m5 5H3"/><path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6"/>',
    sliders: '<path d="M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M2 14h4m4-6h4m4 8h4"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/>',
    pause: '<path d="M8 5v14m8-14v14"/>',
    play: '<path d="m7 4 13 8-13 8z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.spark}</svg>`;
}

export function formatDate(value?: string): string {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function statusPill(value: string): string {
  const normalized = value.toLowerCase().replaceAll("_", " ");
  return `<span class="status-pill status-${escapeHtml(value.toLowerCase())}"><span class="status-dot"></span>${escapeHtml(normalized)}</span>`;
}

export function button(label: string, action: string, kind = "secondary", iconName?: string): string {
  return `<button type="button" class="button button-${kind}" data-action="${escapeHtml(action)}">${iconName ? icon(iconName, 16) : ""}<span>${escapeHtml(label)}</span></button>`;
}
