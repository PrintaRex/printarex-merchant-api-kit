/**
 * Links and downloads that come from API data are used only with these protocols: https, and http
 * only when the API itself is http (a local sandbox). Anything else, such as `javascript:` or
 * `file:`, is refused.
 */
export function allowedProtocols(apiBaseUrl: string): string[] {
  return new URL(apiBaseUrl).protocol === 'http:' ? ['https:', 'http:'] : ['https:'];
}

/** The normalised absolute URL when it is safe to put in a link, otherwise null. */
export function safeHref(rawUrl: string | null, protocols: string[]): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return protocols.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
