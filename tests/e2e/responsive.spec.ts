import { expect, test, type Page } from "@playwright/test";
import { signUp, testEmail } from "./support/auth";
import { CN_TOWER, importSmallCollection, writeNote } from "./support/notes";

/**
 * Every page, at every width people actually use.
 *
 * Samah kept finding layout faults by hand — a card off the side of a phone, a
 * tag chip with its count sitting lower and larger than its name, controls
 * sitting on top of each other. Those are not judgement calls; they are
 * measurable, and a person should not be the mechanism that discovers them.
 *
 * Six classes of fault are checked, because these are the ones that keep
 * happening here — each one added the day a person found it by eye:
 *
 *   1. **Sideways spill.** The page must never scroll horizontally.
 *   2. **Overlap.** Two controls must not sit on top of one another, which is
 *      how a dropdown ends up covering the button beside it.
 *   3. **Vertical drift.** Items on one visual row must share a baseline band —
 *      the tag-count bug was a `.note` inside a chip inheriting a larger font
 *      and a top margin, which reads as "the spacing looks weird".
 *   4. **Stranded text.** A box given a height must centre what is in it.
 *   5. **Margins fighting a row.** A flex row spaces its children with `gap`;
 *      a child's own block margin only knocks it out of line.
 *   6. **Clipped placeholders.** Text that cannot wrap must fit its box.
 *   7. **Controls escaping their container.** `min-width: auto` on a flex or
 *      grid item lets an intrinsically wide control — a date input above all —
 *      paint straight through whatever is beside it.
 *   8. **Native control chrome.** Select chevrons and date pickers are drawn by
 *      the UA, which paints them for a light page unless `color-scheme` says so.
 *
 * Every page is measured twice: at rest, and again with every editor, tag form,
 * filter panel and `<details>` opened. The second pass exists because the first
 * reported eight clean pages while the note editor — collapsed until someone
 * presses Edit — had never been rendered into the DOM at all.
 *
 * And all of it now runs with a **touch pointer** on the tablet and phone,
 * which it did not before — see `VIEWPORTS`.
 */

/**
 * `touch` is not decoration — it decides whether a whole stylesheet block runs.
 *
 * These tests only ever called `setViewportSize`, which changes the width and
 * nothing else. `@media (pointer: coarse)` therefore never matched, so the
 * touch rules — the ones that raise controls to a tap target — were never
 * exercised at any width. That is precisely where the tag-chip fault lived: a
 * chip given a 2.75rem min-height for touch, with its text still sitting at the
 * top of the box. The suite reported three clean viewports because it was
 * measuring a phone-width desktop, which is not a phone.
 */
const VIEWPORTS = [
  { name: "laptop", width: 1440, height: 900, touch: false },
  { name: "tablet", width: 768, height: 1024, touch: true },
  { name: "phone", width: 390, height: 844, touch: true },
] as const;

/**
 * Every touch viewport is also measured rotated.
 *
 * Landscape was simply missing: three portrait widths were being called "all
 * common screen sizes", and a phone turned sideways is neither a phone width
 * nor a tablet width. 874px lands in a gap where a two-column layout is still
 * on but barely fits — which is exactly where Samah found two controls
 * overlapping, and no viewport here would ever have looked.
 *
 * Done by rotating inside the test rather than as separate tests, deliberately.
 * Each test signs up a real account against Clerk's development instance, and
 * adding two more parallel sign-ups made them fail on the one-time-code step
 * rather than on anything about layout. Rotation needs no second account, and
 * the page under test is the same page.
 */
const ROTATE = { laptop: false, tablet: true, phone: true } as const;

const target = process.env.E2E_BASE_URL ?? "http://localhost:3100";
test.skip(
  !(target.includes("localhost") || target.includes("127.0.0.1")),
  "Creates users, so local disposable databases only.",
);
test.describe.configure({ timeout: 180_000 });

/** How far the document scrolls sideways. Anything above zero is a bug. */
async function sidewaysSpill(
  page: Page,
): Promise<{ spill: number; widest: string }> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    let widest = "(nothing)";
    let worst = 0;
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const over = box.right - doc.clientWidth;
      if (over > worst) {
        worst = over;
        widest = `${el.tagName.toLowerCase()}.${el.className || "(none)"} +${Math.round(over)}px`;
      }
    }
    return { spill: doc.scrollWidth - doc.clientWidth, widest };
  });
}

/**
 * Interactive elements that visually cover one another.
 *
 * Siblings that merely touch are fine; this looks for a genuine intersection of
 * more than a couple of pixels, and ignores ancestor/descendant pairs, which
 * overlap by definition.
 */
async function overlappingControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        "a, button, select, input, textarea",
      ),
    ).filter((el) => {
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return (
        box.width > 1 &&
        box.height > 1 &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        // A control inside an open <dialog> legitimately sits over the page.
        !el.closest("dialog[open]")
      );
    });

    const describe = (el: HTMLElement) =>
      `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${el.className || "(none)"}`;

    const found: string[] = [];
    for (let i = 0; i < controls.length; i++) {
      for (let j = i + 1; j < controls.length; j++) {
        const a = controls[i]!;
        const b = controls[j]!;
        if (a.contains(b) || b.contains(a)) continue;
        // A label wrapping its own input is one control, not two.
        if (a.closest("label") && a.closest("label") === b.closest("label"))
          continue;

        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const overlapX =
          Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const overlapY =
          Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (overlapX > 2 && overlapY > 2) {
          found.push(`${describe(a)} over ${describe(b)}`);
        }
      }
    }
    return [...new Set(found)];
  });
}

/**
 * Inline items on one row whose text baselines disagree badly.
 *
 * This is what "the spacing looks weird" turned out to mean: a chip's count
 * inheriting a bigger font and a top margin, so it sat lower and larger than
 * the word beside it.
 */
async function misalignedChipParts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const chip of Array.from(
      document.querySelectorAll<HTMLElement>(".chip"),
    )) {
      const parent = getComputedStyle(chip);
      for (const child of Array.from(chip.children) as HTMLElement[]) {
        const style = getComputedStyle(child);
        const parentSize = parseFloat(parent.fontSize);
        const childSize = parseFloat(style.fontSize);
        if (childSize > parentSize + 0.5) {
          bad.push(
            `${chip.className}: child font ${childSize}px > chip ${parentSize}px`,
          );
        }
        const marginTop = parseFloat(style.marginTop);
        if (marginTop > 0.5) {
          bad.push(
            `${chip.className}: child has ${marginTop}px top margin inside a chip`,
          );
        }
      }
    }
    return [...new Set(bad)];
  });
}

/**
 * Text stranded at the top or bottom of a box that was given a height.
 *
 * A control handed a `min-height` it did not ask for — a tap target, usually —
 * has to centre its own contents, and `display: inline-block` does not. The
 * result is a tall pill with its word near the top, which reads to a person as
 * "the spacing looks weird" rather than as any nameable defect.
 *
 * Measured off the text itself with a Range, so it holds however the centring
 * is achieved, and only for single-line content where centring is unambiguous.
 */
async function strandedText(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )) {
      const style = getComputedStyle(el);
      // `min-height: auto` parses to NaN, and `NaN <= 0` is false — so a naive
      // check here measured every element on the page rather than the few that
      // were given a height. Ask the positive question instead.
      const floor = parseFloat(style.minHeight);
      if (!(floor > 0)) continue;
      if (!el.textContent?.trim()) continue;

      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      if (text.height === 0 || box.height === 0) continue;
      // Multi-line content has no single right answer; skip it.
      if (text.height > parseFloat(style.lineHeight || "0") * 1.6) continue;

      const above = text.top - box.top;
      const below = box.bottom - text.bottom;
      if (Math.abs(above - below) > 4) {
        bad.push(
          `${el.tagName.toLowerCase()}.${el.className || "(none)"}: text sits ` +
            `${Math.round(above)}px from the top and ${Math.round(below)}px from the bottom`,
        );
      }
    }
    return [...new Set(bad)];
  });
}

/**
 * A block margin on a child of a horizontal flex row.
 *
 * These rows space their children with `gap` and level them with
 * `align-items: center`, so a child's own top margin does nothing except push
 * it out of line with everything beside it. This is one root cause with three
 * symptoms: "Sort" sitting below its dropdowns, "Dated now" sitting below
 * "Cancel", and "Tags" sitting below the tag chips — all of them a `.note`,
 * whose paragraph margin is correct underneath something and wrong beside it.
 *
 * Only row-direction containers are checked. A margin in a flex *column* is
 * ordinary and often deliberate.
 */
async function marginsInRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )) {
      const style = getComputedStyle(row);
      if (style.display !== "flex" && style.display !== "inline-flex") continue;
      if (style.flexDirection.startsWith("column")) continue;
      if (style.alignItems !== "center") continue;

      for (const child of Array.from(row.children) as HTMLElement[]) {
        const childStyle = getComputedStyle(child);
        const top = parseFloat(childStyle.marginTop);
        const bottom = parseFloat(childStyle.marginBottom);
        if (top > 0.5 || bottom > 0.5) {
          bad.push(
            `${child.tagName.toLowerCase()}.${child.className || "(none)"} has a ` +
              `${Math.round(top)}/${Math.round(bottom)}px block margin inside a centred row`,
          );
        }
      }
    }
    return [...new Set(bad)];
  });
}

/**
 * Placeholder text wider than the box holding it.
 *
 * A placeholder is the one string in a form that cannot wrap, cannot ellipsize
 * and cannot be scrolled to — it is simply cut mid-word, which on a phone made
 * "A Spotify or Apple Music track, album or playlist" render as "A Spotify or
 * Apple Music trac". None of the earlier checks could see it: nothing overflows
 * the page, nothing overlaps, and the clipping happens inside the input's own
 * box. It has to be measured against the font to be found at all.
 */
async function clippedPlaceholders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];

    const bad: string[] = [];
    const fields = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input, textarea",
      ),
    );
    for (const field of fields) {
      const text = field.placeholder;
      if (!text) continue;
      // A textarea wraps, so a long placeholder there is not clipped.
      if (field.tagName === "TEXTAREA") continue;

      const style = getComputedStyle(field);
      if (style.display === "none" || style.visibility === "hidden") continue;
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

      const needed = ctx.measureText(text).width;
      const available =
        field.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight);
      /**
       * Fit with headroom, not merely fit.
       *
       * The font stack is `ui-sans-serif, system-ui, …`, which resolves to SF
       * Pro on a Mac and to whatever `sans-serif` means on a Linux CI runner —
       * and the latter is several percent wider. Three placeholders passed this
       * check locally and failed it in CI for that reason alone. A string that
       * only just fits in one font does not fit; it is one substitution away
       * from being cut off, and the substitution is not hypothetical.
       */
      if (available > 0 && needed > available * 0.9) {
        bad.push(
          `${field.id || field.name || "input"}: placeholder needs ` +
            `${Math.round(needed)}px in a ${Math.round(available)}px box — “${text}”`,
        );
      }
    }
    return [...new Set(bad)];
  });
}

/**
 * A control drawn outside the box that was supposed to contain it.
 *
 * This is the engine-independent way to catch an intrinsic-width blowout. A
 * flex or grid item defaults to `min-width: auto` and will not shrink below the
 * intrinsic width of its contents; `<input type="date">` is the worst offender,
 * because its intrinsic width is a whole localized date plus the picker's own
 * chrome — and that is **much wider in iOS Safari than in headless Chromium**.
 * The item then refuses to shrink and the input is painted straight through
 * whatever sits beside it.
 *
 * Comparing a control against its own parent finds that wherever it happens,
 * without needing the engine to reproduce one specific intrinsic width.
 */
async function overflowsItsContainer(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>("input, select, textarea, button"),
    );
    for (const el of controls) {
      const parent = el.parentElement;
      if (!parent) continue;
      const box = el.getBoundingClientRect();
      const around = parent.getBoundingClientRect();
      if (box.width === 0 || around.width === 0) continue;
      // A parent that scrolls its own overflow is doing so deliberately.
      const flow = getComputedStyle(parent).overflowX;
      if (flow === "auto" || flow === "scroll") continue;

      const over = Math.round(
        Math.max(box.right - around.right, around.left - box.left),
      );
      if (over > 2) {
        bad.push(
          `${el.tagName.toLowerCase()}#${el.id || el.getAttribute("name") || "?"} ` +
            `overflows ${parent.tagName.toLowerCase()}.${parent.className || "(none)"} by ${over}px`,
        );
      }
    }
    return [...new Set(bad)];
  });
}

/**
 * A form control sharing a line with something, in a box that cannot shrink.
 *
 * This is the check that actually catches the date/precision fault, and it had
 * to be written twice. The obvious version measured whether a control was
 * painted outside its container — and **it did not catch anything**, because
 * headless WebKit's `<input type="date">` is narrower than real iOS Safari's.
 * The fault reproduces on a phone in a way no engine available here reproduces,
 * so measuring the symptom can never be reliable.
 *
 * The *cause* is engine-independent, and it is a CSS fact rather than a
 * rendered one: a flex or grid item defaults to `min-width: auto`, which
 * refuses to shrink below the intrinsic width of its contents. For a paragraph
 * that is harmless. For a box holding a control whose intrinsic width is set by
 * UA chrome nobody controls — a date picker, a select, a file input — it means
 * the layout is one wide locale or one browser away from overlapping, and
 * whether it does is not something this suite gets to observe.
 *
 * So the rule is stated directly: if a control shares a line, its box must be
 * allowed to shrink. Cheap, total, and true in every engine.
 */
async function unshrinkableControlBoxes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const parent of Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )) {
      const style = getComputedStyle(parent);
      const horizontalFlex =
        (style.display === "flex" || style.display === "inline-flex") &&
        !style.flexDirection.startsWith("column");
      const multiColumnGrid =
        (style.display === "grid" || style.display === "inline-grid") &&
        style.gridTemplateColumns.split(" ").filter(Boolean).length > 1;
      if (!horizontalFlex && !multiColumnGrid) continue;

      const items = Array.from(parent.children) as HTMLElement[];
      // A lone item has the whole line and cannot collide with a sibling.
      if (items.length < 2) continue;

      for (const item of items) {
        if (!item.querySelector("input, select, textarea")) continue;
        if (getComputedStyle(item).minWidth !== "auto") continue;
        bad.push(
          `${item.tagName.toLowerCase()}.${item.className || "(none)"} holds a control ` +
            `and shares a line inside ${parent.tagName.toLowerCase()}.${parent.className || "(none)"}, ` +
            `but has min-width:auto — it cannot shrink below its contents' intrinsic width`,
        );
      }
    }
    return [...new Set(bad)];
  });
}

/**
 * A native control whose size the UA decides, in a layout that cannot afford it.
 *
 * While `appearance` is `auto`, a control's used width comes from platform
 * metrics rather than from `width` — and those metrics differ per platform by
 * a lot. `<input type="date">` is the extreme case: iOS sizes it to a full
 * localized date plus picker chrome, headless WebKit sizes it to much less. So
 * a date input inside a narrow column is a control this suite is structurally
 * unable to measure, and it overflowed on a real iPhone three separate times
 * while every engine here reported it contained.
 *
 * The rule, therefore, is not about pixels at all: a date input in a shared or
 * constrained column must have its appearance neutralized, so its width is
 * author-decided and every engine agrees on it. That is checkable anywhere.
 */
async function uaSizedDateInputs(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="date"]'),
    )) {
      const style = getComputedStyle(el);
      const appearance =
        style.appearance ||
        (style as unknown as Record<string, string>).webkitAppearance;
      if (appearance !== "none") {
        bad.push(
          `input[type=date]#${el.id || "?"} still has appearance:${appearance} — ` +
            `its width is decided by platform metrics this suite cannot reproduce`,
        );
      }
    }
    return [...new Set(bad)];
  });
}

/**
 * Native controls must be painted for the theme the page is actually wearing.
 *
 * A `<select>`'s chevron, a date picker, a checkbox tick and a scrollbar are
 * drawn by the UA, not from the stylesheet, and the UA assumes a light page
 * unless `color-scheme` says otherwise. Every colour token here flips on
 * `prefers-color-scheme`, and none of that reached the chevrons — they stayed
 * black on a near-black select. No amount of styling the select can fix it,
 * because the chevron is not in the DOM and cannot be selected. Only the
 * declaration can, so the declaration is what is asserted.
 */
async function nativeControlsFollowTheTheme(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const declared = getComputedStyle(document.documentElement).colorScheme;
    if (!/dark/.test(declared)) {
      return [
        `:root declares color-scheme "${declared}" — native control chrome ` +
          `(select chevrons, date pickers, checkboxes) is painted for a light page`,
      ];
    }
    return [];
  });
}

/**
 * Open everything that hides behind a click, then measure again.
 *
 * **This is the gap that let the date/precision overlap reach production.** The
 * sweep walked eight pages and reported them clean, but the note editor is
 * collapsed until someone presses Edit, so `ExperiencedFields` and
 * `PlaceFields` were never in the DOM at all. The checks were fine; they were
 * pointed at markup that had not been rendered yet. A layout test that only
 * ever sees a page's resting state is not testing the page.
 */
async function revealCollapsedSurfaces(page: Page): Promise<void> {
  for (const name of [/^edit$/i, /more filters/i]) {
    const buttons = page.getByRole("button", { name });
    const count = await buttons.count();
    for (let i = 0; i < count; i += 1) {
      const button = buttons.nth(i);
      if (await button.isVisible().catch(() => false)) {
        await button.click().catch(() => {});
      }
    }
  }
  // <details> panels open without React, so set them directly.
  await page.evaluate(() => {
    for (const d of Array.from(document.querySelectorAll("details")))
      d.open = true;
  });
  await page.waitForTimeout(150);
}

/** Seed enough content that pages are not empty shells. */
async function seed(page: Page): Promise<string> {
  await writeNote(page, {
    ...CN_TOWER,
    body: "a note to give the page something to lay out",
  });
  /**
   * Tags are part of editing a note now, not a second form beside it — "Edit"
   * and "Add tags" used to be two ways into the same card, each with its own
   * open-change-save round.
   */
  await page
    .getByRole("button", { name: /^edit$/i })
    .first()
    .click();
  await page.locator("input[name='tags']").first().fill("qawwali, late night");
  await page
    .getByRole("button", { name: /^save$/i })
    .first()
    .click();
  await expect(page.locator("a.chip.tag").first()).toBeVisible({
    timeout: 30_000,
  });

  await importSmallCollection(page);
  return page.url();
}

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    // Set on the context, not the page: `hasTouch` is what makes
    // `pointer: coarse` match, and it cannot be changed after the context
    // exists the way a viewport can.
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
    });

    test(`${viewport.name} — no page spills, overlaps or misaligns`, async ({
      page,
    }) => {
      await expect
        .poll(() =>
          page.evaluate(() => matchMedia("(pointer: coarse)").matches),
        )
        .toBe(viewport.touch);
      await signUp(page, testEmail(`responsive-${viewport.name}`));
      const collectionUrl = await seed(page);

      const pages: Array<[string, string]> = [
        ["notes", "/notes"],
        ["notes, filtered", "/notes?tag=qawwali"],
        ["notes, searched", "/notes?q=note"],
        ["notes, sorted", "/notes?sort=artist&dir=asc"],
        ["collections", "/collections"],
        ["a collection", collectionUrl],
        ["account", "/account"],
        ["about", "/about"],
      ];

      const problems: string[] = [];

      for (const [name, url] of pages) {
        await page.goto(url);
        /**
         * Wait for the content, not for the network to go quiet.
         *
         * `waitForLoadState("networkidle")` hung here and timed the whole test
         * out at three minutes. On a signed-in page the network never *is* idle —
         * Clerk polls in the background, and the recently-played strip polls
         * Last.fm — so the condition can simply never arrive. Playwright
         * discourages it for exactly this reason. A visible landmark is the thing
         * actually being waited for.
         */
        await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });

        const { spill, widest } = await sidewaysSpill(page);
        if (spill > 0)
          problems.push(
            `${name}: scrolls sideways by ${spill}px — widest ${widest}`,
          );

        for (const overlap of await overlappingControls(page)) {
          problems.push(`${name}: ${overlap}`);
        }
        for (const misaligned of await misalignedChipParts(page)) {
          problems.push(`${name}: ${misaligned}`);
        }
        for (const stranded of await strandedText(page)) {
          problems.push(`${name}: ${stranded}`);
        }
        for (const margin of await marginsInRows(page)) {
          problems.push(`${name}: ${margin}`);
        }
        for (const clipped of await clippedPlaceholders(page)) {
          problems.push(`${name}: ${clipped}`);
        }
        for (const theme of await nativeControlsFollowTheTheme(page)) {
          problems.push(`${name}: ${theme}`);
        }

        // Then again with every editor, tag form, filter panel and <details>
        // open — the state a person is in when actually using the page.
        await revealCollapsedSurfaces(page);

        const opened = await sidewaysSpill(page);
        if (opened.spill > 0) {
          problems.push(
            `${name} (opened): scrolls sideways by ${opened.spill}px — widest ${opened.widest}`,
          );
        }
        for (const overlap of await overlappingControls(page)) {
          problems.push(`${name} (opened): ${overlap}`);
        }
        for (const over of await overflowsItsContainer(page)) {
          problems.push(`${name} (opened): ${over}`);
        }
        for (const rigid of await unshrinkableControlBoxes(page)) {
          problems.push(`${name} (opened): ${rigid}`);
        }
        for (const ua of await uaSizedDateInputs(page)) {
          problems.push(`${name} (opened): ${ua}`);
        }
        for (const stranded of await strandedText(page)) {
          problems.push(`${name} (opened): ${stranded}`);
        }
        for (const margin of await marginsInRows(page)) {
          problems.push(`${name} (opened): ${margin}`);
        }
        for (const clipped of await clippedPlaceholders(page)) {
          problems.push(`${name} (opened): ${clipped}`);
        }

        // Then the same page, same session, turned sideways.
        if (ROTATE[viewport.name as keyof typeof ROTATE]) {
          await page.setViewportSize({
            width: viewport.height,
            height: viewport.width,
          });
          await expect(page.locator("main")).toBeVisible({ timeout: 30_000 });

          const turned = `${name} (landscape)`;
          const rotated = await sidewaysSpill(page);
          if (rotated.spill > 0) {
            problems.push(
              `${turned}: scrolls sideways by ${rotated.spill}px — widest ${rotated.widest}`,
            );
          }
          for (const overlap of await overlappingControls(page)) {
            problems.push(`${turned}: ${overlap}`);
          }
          for (const over of await overflowsItsContainer(page)) {
            problems.push(`${turned}: ${over}`);
          }
          for (const rigid of await unshrinkableControlBoxes(page)) {
            problems.push(`${turned}: ${rigid}`);
          }
          for (const stranded of await strandedText(page)) {
            problems.push(`${turned}: ${stranded}`);
          }
          for (const clipped of await clippedPlaceholders(page)) {
            problems.push(`${turned}: ${clipped}`);
          }
          await page.setViewportSize({
            width: viewport.width,
            height: viewport.height,
          });
        }
      }

      expect(problems, `\n  - ${problems.join("\n  - ")}\n`).toEqual([]);
    });
  });
}
