/**
 * A display name: optional, free-form, and short.
 *
 * Pseudonyms are fine and nothing here asks for a real name. The rules are only
 * the ones that keep it displayable: trimmed, whitespace collapsed, control
 * characters removed, and capped so it cannot push a page layout around. Empty
 * means "use the username", stored as null rather than as an empty string.
 */
export const DISPLAY_NAME_MAX = 50;

export function normalizeDisplayName(raw: string): string | null {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DISPLAY_NAME_MAX)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}
