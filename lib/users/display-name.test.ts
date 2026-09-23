import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX, normalizeDisplayName } from "./display-name";

describe("display names", () => {
  it("is optional — empty becomes null, meaning 'use the username'", () => {
    expect(normalizeDisplayName("")).toBeNull();
    expect(normalizeDisplayName("   ")).toBeNull();
  });

  it("allows a pseudonym and ordinary punctuation", () => {
    expect(normalizeDisplayName("DJ Kool-Herc (the original)")).toBe("DJ Kool-Herc (the original)");
    expect(normalizeDisplayName("Zoë")).toBe("Zoë");
  });

  it("collapses whitespace", () => {
    expect(normalizeDisplayName("  Samah   Bin  Saeed ")).toBe("Samah Bin Saeed");
  });

  /** Direction overrides can make a name render as something it is not. */
  it("strips control and bidirectional-override characters", () => {
    expect(normalizeDisplayName("sam‮ah")).toBe("samah");
    expect(normalizeDisplayName("a\u0000b")).toBe("ab");
  });

  it("is capped", () => {
    expect(normalizeDisplayName("x".repeat(200))!.length).toBe(DISPLAY_NAME_MAX);
  });
});
