const DASHBOARD_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://telegram.org https://oauth.telegram.org",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' https: data:",
  "connect-src 'self' https://oauth.telegram.org",
  "frame-src https://oauth.telegram.org",
].join("; ");

/** Adds browser isolation and resource restrictions to dashboard and public chat HTML. */
export function withDashboardSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("cross-origin-opener-policy", "same-origin-allow-popups");
  headers.set("content-security-policy", DASHBOARD_CONTENT_SECURITY_POLICY);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
