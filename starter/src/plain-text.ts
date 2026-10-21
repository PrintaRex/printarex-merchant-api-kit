const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

/**
 * Turns `description_html` into paragraphs of PLAIN text; the caller escapes them.
 *
 * The HTML is written by the merchant and not sanitised by PrintaRex. A Content-Security-Policy
 * cannot stop `<meta http-equiv=refresh>` redirects or fake content made with inline styles, so
 * the markup is dropped instead of cleaned. A real shop that wants bold text, lists or links
 * should run the HTML through a maintained sanitiser library, not through code like this.
 */
export function descriptionParagraphs(html: string): string[] {
  const withoutCode = html.replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ').replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const withBreaks = withoutCode.replace(/<\/(?:p|div|li|h[1-6]|tr)\s*>|<br\s*\/?>/gi, '\n');
  const text = withBreaks.replace(/<[^>]*>/g, '').replace(/&(?:lt|gt|quot|#39|apos|nbsp);/g, (entity) => ENTITIES[entity] ?? entity).replace(/&amp;/g, '&');
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
