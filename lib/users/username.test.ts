import { describe, expect, it } from "vitest";
import { checkUsernameShape, normalizeUsername } from "./username";

/**
 * The rules that decide a handle. Pure checks, so no database is involved —
 * uniqueness is the index's job and is tested where the index is.
 */
describe("username shape", () => {
  it("accepts letters, digits and underscores between 3 and 30 characters", () => {
    for (const name of ["sam", "samah_binsaeed", "a_1", "x".repeat(30)]) {
      expect(checkUsernameShape(name)).toBeNull();
    }
  });

  it("folds case, so one person cannot be two accounts", () => {
    expect(normalizeUsername("  SamaH ")).toBe("samah");
    expect(checkUsernameShape("SAMAH")).toBeNull();
  });

  it("rejects lengths and characters that invite confusion", () => {
    for (const name of ["ab", "x".repeat(31), "sam.ah", "sam-ah", "sam ah", "samah!", "héllo"]) {
      expect(checkUsernameShape(name)).toBe("shape");
    }
  });

  /**
   * A profile is going to live at a top-level path. Letting someone take
   * "settings" now is a problem that only surfaces the day that route ships,
   * by which time it belongs to a real person.
   */
  it("reserves route names and impersonation risks", () => {
    for (const name of ["settings", "admin", "notes", "trackjot", "support", "www"]) {
      expect(checkUsernameShape(name)).toBe("reserved");
    }
  });
});

describe("turning something into a username candidate", () => {
  it("keeps a clean handle as it is", async () => {
    const { toUsernameCandidate } = await import("./username");
    expect(toUsernameCandidate("samah")).toBe("samah");
  });

  it("folds punctuation, case and accents into the allowed alphabet", async () => {
    const { toUsernameCandidate } = await import("./username");
    expect(toUsernameCandidate("Samah.Bin-Saeed")).toBe("samah_bin_saeed");
    expect(toUsernameCandidate("Zoë Kravitz")).toBe("zoe_kravitz");
  });

  it("gives up on something too short to be a handle", async () => {
    const { toUsernameCandidate } = await import("./username");
    expect(toUsernameCandidate("a")).toBeNull();
    expect(toUsernameCandidate("..")).toBeNull();
  });

  it("never proposes a reserved word as-is", async () => {
    const { toUsernameCandidate, checkUsernameShape } = await import("./username");
    const candidate = toUsernameCandidate("admin")!;
    expect(checkUsernameShape(candidate)).toBeNull();
  });
});
