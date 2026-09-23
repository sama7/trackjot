/**
 * A short, standard list of time zones, ordered by UTC offset.
 *
 * ## Why not every zone the runtime knows
 *
 * The setting offered `Intl.supportedValuesOf("timeZone")` — over four hundred
 * entries, alphabetised by IANA name. That is a list for a machine: finding your
 * own zone meant scrolling past forty "Africa/…" entries, and names like
 * "America/Indiana/Tell_City" answer a question nobody asked. People think of a
 * time zone as an offset and a few cities they recognise, so that is the shape.
 *
 * ## How the list was chosen
 *
 * One entry per offset *and daylight-saving rule* that a meaningful number of
 * people live under. Two places can share an offset and still disagree for half
 * the year — Denver and Phoenix, Sydney and Brisbane — and those stay separate,
 * because folding them together would put the wrong time on someone's notes
 * every summer. Places that share both are listed together in one label.
 *
 * Anyone the list misses is not stuck: the device's own zone is always offered
 * as well, and a zone already saved is always kept.
 */

export interface CommonZone {
  /** The IANA zone that is actually stored. */
  zone: string;
  /** What a person recognises. */
  places: string;
}

export const COMMON_TIME_ZONES: CommonZone[] = [
  { zone: "Pacific/Pago_Pago", places: "American Samoa, Midway" },
  { zone: "Pacific/Honolulu", places: "Hawaii" },
  { zone: "America/Anchorage", places: "Alaska" },
  { zone: "America/Los_Angeles", places: "Pacific Time — Los Angeles, Vancouver, Seattle" },
  { zone: "America/Denver", places: "Mountain Time — Denver, Calgary, Salt Lake City" },
  { zone: "America/Phoenix", places: "Arizona — Phoenix (no daylight saving)" },
  { zone: "America/Chicago", places: "Central Time — Chicago, Dallas, Winnipeg" },
  { zone: "America/Mexico_City", places: "Mexico City, Guatemala, Costa Rica" },
  { zone: "America/New_York", places: "Eastern Time — New York, Toronto, Miami" },
  { zone: "America/Bogota", places: "Bogotá, Lima, Panama" },
  { zone: "America/Halifax", places: "Atlantic Time — Halifax, Bermuda" },
  { zone: "America/Caracas", places: "Caracas, La Paz, Puerto Rico" },
  { zone: "America/St_Johns", places: "Newfoundland" },
  { zone: "America/Sao_Paulo", places: "São Paulo, Buenos Aires, Montevideo" },
  { zone: "UTC", places: "Coordinated Universal Time" },
  { zone: "Europe/London", places: "London, Dublin, Lisbon" },
  { zone: "Atlantic/Reykjavik", places: "Reykjavík, Accra, Dakar (no daylight saving)" },
  { zone: "Europe/Paris", places: "Central Europe — Paris, Berlin, Madrid, Rome" },
  { zone: "Africa/Lagos", places: "West Africa — Lagos, Kinshasa, Algiers" },
  { zone: "Europe/Athens", places: "Eastern Europe — Athens, Helsinki, Kyiv" },
  { zone: "Africa/Cairo", places: "Cairo" },
  { zone: "Africa/Johannesburg", places: "Johannesburg, Harare, Maputo" },
  { zone: "Europe/Moscow", places: "Moscow, Istanbul, Minsk" },
  { zone: "Asia/Riyadh", places: "Riyadh, Doha, Baghdad, Nairobi" },
  { zone: "Asia/Tehran", places: "Tehran" },
  { zone: "Asia/Dubai", places: "Dubai, Abu Dhabi, Baku, Tbilisi" },
  { zone: "Asia/Karachi", places: "Karachi, Tashkent" },
  { zone: "Asia/Kolkata", places: "India, Sri Lanka" },
  { zone: "Asia/Dhaka", places: "Dhaka, Almaty" },
  { zone: "Asia/Bangkok", places: "Bangkok, Hanoi, Jakarta" },
  { zone: "Asia/Singapore", places: "Beijing, Hong Kong, Singapore, Taipei, Perth" },
  { zone: "Asia/Tokyo", places: "Tokyo, Seoul" },
  { zone: "Australia/Adelaide", places: "Adelaide" },
  { zone: "Australia/Brisbane", places: "Brisbane, Guam (no daylight saving)" },
  { zone: "Australia/Sydney", places: "Sydney, Melbourne, Canberra" },
  { zone: "Pacific/Noumea", places: "Solomon Islands, New Caledonia" },
  { zone: "Pacific/Auckland", places: "Auckland, Wellington" },
  { zone: "Pacific/Tongatapu", places: "Tonga, Samoa" },
];

/** Minutes east of UTC for `zone` at `when`, read from the runtime's own data. */
function offsetAt(zone: string, when: Date): number {
  const name =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
      .formatToParts(when)
      .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const match = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/**
 * The zone's *standard* offset — the one it keeps outside daylight saving.
 *
 * Taken as the smaller of its January and July offsets, which is right in both
 * hemispheres: New York is −5 in January and −4 in July, Sydney +11 in January
 * and +10 in July, and the standard offset is the smaller in each case. Labels
 * built from the current offset would reorder the list every spring.
 */
export function standardOffset(zone: string): number {
  const year = 2026;
  return Math.min(
    offsetAt(zone, new Date(Date.UTC(year, 0, 15))),
    offsetAt(zone, new Date(Date.UTC(year, 6, 15))),
  );
}

/** "UTC−05:00", with a real minus sign. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const abs = Math.abs(minutes);
  const h = String(Math.floor(abs / 60)).padStart(2, "0");
  const m = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${h}:${m}`;
}

/** A zone name as a person would read it: "America/Indiana/Tell_City" → "Tell City". */
function cityOf(zone: string): string {
  return (zone.split("/").pop() ?? zone).replace(/_/g, " ");
}

export interface ZoneOption {
  value: string;
  label: string;
}

/**
 * The options to show, in offset order.
 *
 * `extras` are zones that must be offered even when they are not common — the
 * one this device reports, and the one already saved — so the short list never
 * forces anyone onto a zone that is not theirs.
 */
export function timeZoneOptions(extras: Array<string | null | undefined> = []): ZoneOption[] {
  const known = new Set(COMMON_TIME_ZONES.map((z) => z.zone));
  const rows: Array<{ value: string; places: string; offset: number }> = COMMON_TIME_ZONES.map(
    (z) => ({ value: z.zone, places: z.places, offset: standardOffset(z.zone) }),
  );

  for (const zone of extras) {
    if (!zone || known.has(zone) || !isTimeZone(zone)) continue;
    known.add(zone);
    rows.push({ value: zone, places: cityOf(zone), offset: standardOffset(zone) });
  }

  return rows
    .sort((a, b) => a.offset - b.offset || a.places.localeCompare(b.places))
    .map((r) => ({ value: r.value, label: `(${formatOffset(r.offset)}) ${r.places}` }));
}

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
