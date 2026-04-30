/**
 * URL-friendly slug helpers for team / entity names.
 *
 *   toSlug("Saint Mary's") → "saint-marys"
 *   fromSlug("saint-marys") → "saint marys" (consumed by case-insensitive resolver)
 */

export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[''']/g, '')         // strip apostrophes
    .replace(/\./g, '')             // strip periods
    .replace(/&/g, '')              // strip ampersands
    .replace(/\(([^)]*)\)/g, '$1')  // unwrap parentheses: "(OH)" → "OH"
    .replace(/[^a-z0-9\s-]/g, '')   // drop remaining special chars
    .trim()
    .replace(/\s+/g, '-')           // spaces → hyphens
    .replace(/-+/g, '-')            // collapse multiple hyphens
    .replace(/^-|-$/g, '');         // trim leading/trailing hyphens
}

export function fromSlug(slug: string): string {
  return slug.replace(/-/g, ' ').trim();
}
