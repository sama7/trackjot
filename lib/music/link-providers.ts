import { tidalConfigured } from "@/lib/music/tidal/api";

/**
 * The services a pasted link can come from, as a phrase for copy.
 *
 * Tidal is named only when it is configured: an unconfigured deployment must
 * never advertise an integration it cannot perform.
 */
export function linkProviderNames(): string {
  return tidalConfigured() ? "Spotify, Apple Music or Tidal" : "Spotify or Apple Music";
}
