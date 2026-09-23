import { describe, expect, it } from "vitest";
import { COMMON_TIME_ZONES, formatOffset, standardOffset, timeZoneOptions } from "./time-zones";

/**
 * The short time-zone list.
 *
 * It replaced the runtime's full list — four hundred-odd IANA names in
 * alphabetical order — which made finding your own zone a scroll through
 * forty "Africa/…" entries.
 */
describe("the common time zone list", () => {
  it("is short", () => {
    expect(COMMON_TIME_ZONES.length).toBeLessThanOrEqual(40);
  });

  it("names only zones the runtime actually knows", () => {
    for (const { zone } of COMMON_TIME_ZONES) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: zone }), zone).not.toThrow();
    }
  });

  it("is ordered by offset, west to east", () => {
    const offsets = timeZoneOptions().map((o) => standardOffset(o.value));
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  /** Standard, not current: otherwise the list would reorder every spring. */
  it("labels each zone by its standard offset in both hemispheres", () => {
    expect(standardOffset("America/New_York")).toBe(-300);
    expect(standardOffset("Australia/Sydney")).toBe(600);
    expect(standardOffset("Asia/Kolkata")).toBe(330);
  });

  it("writes offsets the way a person reads them", () => {
    expect(formatOffset(-300)).toBe("UTC−05:00");
    expect(formatOffset(330)).toBe("UTC+05:30");
    expect(formatOffset(0)).toBe("UTC+00:00");
  });

  /**
   * Sharing an offset is not sharing a clock: Phoenix skips daylight saving and
   * Denver does not, so for half the year they are an hour apart.
   */
  it("keeps apart places that share an offset but not a daylight-saving rule", () => {
    const zones = COMMON_TIME_ZONES.map((z) => z.zone);
    expect(zones).toContain("America/Denver");
    expect(zones).toContain("America/Phoenix");
    expect(zones).toContain("Australia/Sydney");
    expect(zones).toContain("Australia/Brisbane");
  });

  it("always offers a zone that is already saved or reported by the device", () => {
    const values = timeZoneOptions(["America/Indiana/Tell_City", null]).map((o) => o.value);
    expect(values).toContain("America/Indiana/Tell_City");
  });

  it("never offers something that is not a time zone", () => {
    const values = timeZoneOptions(["Not/A_Zone"]).map((o) => o.value);
    expect(values).not.toContain("Not/A_Zone");
  });

  it("labels an uncommon zone by its city", () => {
    const tellCity = timeZoneOptions(["America/Indiana/Tell_City"]).find(
      (o) => o.value === "America/Indiana/Tell_City",
    );
    expect(tellCity?.label).toMatch(/^\(UTC−06:00\) Tell City$/);
  });
});
