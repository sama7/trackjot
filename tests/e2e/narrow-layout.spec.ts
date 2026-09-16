import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

/**
 * Nothing may scroll sideways on a phone.
 *
 * These render real markup against the real stylesheet rather than driving the
 * app, because the bugs they catch live in CSS and reproducing them through the
 * product needs a signed-in account, a connected Last.fm and fresh scrobbles —
 * conditions a test cannot conjure and a person should not have to recreate to
 * find out that a card spills off the screen.
 *
 * This is the second horizontal-overflow bug in this project; the collection
 * tracklist was the first. Both were invisible on a laptop and obvious on a
 * phone, which is exactly the kind of thing a test should be watching for.
 */

const NARROW = { width: 402, height: 874 }; // iPhone 16 Pro
const NARROWEST = { width: 320, height: 640 }; // the smallest we support

async function stylesheet(): Promise<string> {
  return readFile("app/globals.css", "utf8");
}

/** Mount markup with the app's real CSS and report any sideways spill. */
async function overflowOf(
  page: import("@playwright/test").Page,
  body: string,
  viewport: { width: number; height: number },
): Promise<{ documentOverflow: number; widest: string | null }> {
  await page.setViewportSize(viewport);
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${await stylesheet()}</style></head><body>${body}</body></html>`,
  );

  return page.evaluate(() => {
    const doc = document.documentElement;
    const documentOverflow = doc.scrollWidth - doc.clientWidth;

    // Name the widest offender, so a failure says what to go and look at
    // rather than only that something is too wide.
    let widest: string | null = null;
    let worst = 0;
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>("body *"),
    )) {
      const spill = el.getBoundingClientRect().right - doc.clientWidth;
      if (spill > worst) {
        worst = spill;
        widest = `${el.tagName.toLowerCase()}.${el.className || "(no class)"} +${Math.round(spill)}px`;
      }
    }
    return { documentOverflow, widest };
  });
}

/** The picker that spilled: a fieldset of radio rows with covers and long text. */
const MATCH_PICKER = `
<main><ul class="scrobble-list"><li class="scrobble">
  <div class="scrobble-main">
    <div class="scrobble-title"><a href="#">Rasiya</a></div>
    <div class="note">Anyasa · rasiya</div>
    <div class="note scrobble-when">Sep 8, 2026, 11:50 PM</div>
  </div>
  <form class="scrobble-jot inline-edit">
    <fieldset class="sub-fields match-picker">
      <legend>Is this the one?</legend>
      <p class="note">Last.fm didn't include an identifier for this play. Confirming a match gets you the cover art and links, and files it alongside the same track from anywhere else. Nothing is matched for you.</p>
      <label class="match">
        <input type="radio" checked>
        <span class="cover cover-empty" style="width:44px;height:44px"></span>
        <span class="match-text">
          <strong>Rasiya</strong>
          <span class="note">Anyasa, Isheeta Chakrvarty · Gaya EP</span>
          <span class="note">Apple Music · within 0.9s</span>
        </span>
      </label>
      <label class="match match-none">
        <input type="radio">
        <span class="match-text">
          <strong>None of these</strong>
          <span class="note">Keep it as your own entry — private to you, and no cover art.</span>
        </span>
      </label>
    </fieldset>
    <textarea rows="3" placeholder="What do you want to remember about Rasiya?"></textarea>
    <div class="row">
      <button type="submit">Save jot</button>
      <button type="button" class="linkish">Cancel</button>
      <span class="note">Dated Sep 8, 2026, 11:50 PM</span>
    </div>
  </form>
</li></ul></main>`;

/** The note editor, which uses the same fieldsets for date and place. */
const NOTE_EDITOR = `
<main><ul class="notes"><li class="note-card">
  <form class="inline-edit">
    <textarea rows="4"></textarea>
    <fieldset class="sub-fields">
      <legend>When you heard it</legend>
      <p class="note">Leave this empty for "now". A gig in 2011 is dated 2011, not today.</p>
      <div class="field-row">
        <div class="field"><label>Date</label><input id="d" type="date"></div>
        <div class="field"><label>How sure</label><select id="p"><option>That day</option></select></div>
      </div>
    </fieldset>
    <fieldset class="sub-fields">
      <legend>Where you were</legend>
      <div class="field"><label>Place</label><input placeholder="A city or a venue"></div>
      <label class="checkbox"><input type="checkbox"><span>These words name an exact spot, not just the general area. Either way TrackJot saves only what you typed — it never looks the place up and never stores coordinates.</span></label>
    </fieldset>
  </form>
</li></ul></main>`;

test.describe("narrow viewports", () => {
  for (const [name, markup] of [
    ["the scrobble match picker", MATCH_PICKER],
    ["the note editor's date and place fields", NOTE_EDITOR],
  ] as const) {
    test(`${name} does not spill sideways on a phone`, async ({ page }) => {
      const { documentOverflow, widest } = await overflowOf(
        page,
        markup,
        NARROW,
      );
      expect(
        documentOverflow,
        `widest offender: ${widest}`,
      ).toBeLessThanOrEqual(0);
    });

    test(`${name} does not spill sideways at 320px`, async ({ page }) => {
      const { documentOverflow, widest } = await overflowOf(
        page,
        markup,
        NARROWEST,
      );
      expect(
        documentOverflow,
        `widest offender: ${widest}`,
      ).toBeLessThanOrEqual(0);
    });
  }

  /**
   * The picker must stay *readable*, not merely contained — collapsing every
   * row to an ellipsis would pass an overflow check while being useless.
   */
  /** Ellipsing prose hid the half that says what the choice actually does. */
  test("the opt-out explains itself in full rather than being truncated", async ({
    page,
  }) => {
    await page.setViewportSize(NARROW);
    await page.setContent(
      `<!doctype html><html><head><style>${await stylesheet()}</style></head><body>${MATCH_PICKER}</body></html>`,
    );

    const optOut = page.locator("label.match-none .note");
    const clipped = await optOut.evaluate(
      (el) =>
        el.scrollWidth > el.clientWidth + 1 ||
        el.scrollHeight > el.clientHeight + 1,
    );
    expect(clipped, "the opt-out text is cut off").toBe(false);
    await expect(optOut).toContainText("no cover art");
  });

  test("each candidate still shows its title and provider on a phone", async ({
    page,
  }) => {
    await page.setViewportSize(NARROW);
    await page.setContent(
      `<!doctype html><html><head><style>${await stylesheet()}</style></head><body>${MATCH_PICKER}</body></html>`,
    );

    const first = page.locator("label.match").first();
    await expect(first.locator("strong")).toHaveText("Rasiya");
    const box = await first.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(NARROW.width);
  });
});

/** The recently-played strip, with a track playing right now. */
const LIVE_STRIP = `
<main><section class="scrobbles">
  <div class="row scrobbles-head">
    <strong>Recently played</strong>
    <span class="note">from <a href="#">samah-</a> on Last.fm</span>
  </div>
  <ul class="scrobble-list">
    <li class="scrobble live">
      <div class="scrobble-main">
        <div class="scrobble-title"><a href="#">Moved Again</a></div>
        <div class="note">Anhad + Tanner · Silent Days EP</div>
        <div class="note scrobble-when"><span class="playing-bars" aria-hidden="true"><i></i><i></i><i></i></span>Playing now</div>
      </div>
      <button type="button" class="linkish">Jot this</button>
    </li>
    <li class="scrobble">
      <div class="scrobble-main">
        <div class="scrobble-title"><a href="#">Shiva Valley</a></div>
        <div class="note">Anyasa · Shiva Valley</div>
        <div class="note scrobble-when">Sep 9, 2026, 2:41 PM</div>
      </div>
      <button type="button" class="linkish">Jot this</button>
    </li>
  </ul>
</section></main>`;

test.describe("the track playing right now", () => {
  /**
   * The live row is marked by a tint *and* a left edge, and reserves that edge
   * on every row. Without the reservation a track starting or finishing shunts
   * every title sideways, which is the sort of twitch that reads as a bug.
   */
  test("does not shift the other rows when it appears", async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.setContent(
      `<!doctype html><html><head><style>${await stylesheet()}</style></head><body>${LIVE_STRIP}</body></html>`,
    );

    const lefts = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".scrobble-title")).map((t) =>
        Math.round(t.getBoundingClientRect().left),
      ),
    );
    expect(new Set(lefts).size, `titles start at ${lefts.join(", ")}`).toBe(1);
  });

  /** Three bars at one height is a glyph, not a level meter. */
  test("animates its level meter out of step", async ({ page }) => {
    await page.setViewportSize(NARROW);
    await page.setContent(
      `<!doctype html><html><head><style>${await stylesheet()}</style></head><body>${LIVE_STRIP}</body></html>`,
    );
    await page.waitForTimeout(400);

    const heights = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".playing-bars i")).map(
        (b) => Math.round(b.getBoundingClientRect().height * 10) / 10,
      ),
    );
    expect(
      new Set(heights).size,
      `bar heights ${heights.join(", ")}`,
    ).toBeGreaterThan(1);
  });

  /**
   * With reduced motion the global rule collapses every animation to 0.01ms,
   * which would freeze all three bars at the same starting height. Fixed uneven
   * heights still read as a meter while standing perfectly still.
   */
  test("stands still but still reads as a meter under reduced motion", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize(NARROW);
    await page.setContent(
      `<!doctype html><html><head><style>${await stylesheet()}</style></head><body>${LIVE_STRIP}</body></html>`,
    );
    await page.waitForTimeout(200);

    const bars = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".playing-bars i")).map((b) => ({
        h: Math.round(b.getBoundingClientRect().height * 10) / 10,
        animation: getComputedStyle(b).animationName,
      })),
    );
    expect(
      bars.every((b) => b.animation === "none"),
      "animation should be off",
    ).toBe(true);
    expect(
      new Set(bars.map((b) => b.h)).size,
      `heights ${bars.map((b) => b.h).join(", ")}`,
    ).toBeGreaterThan(1);
  });

  /** The meter is decorative; "Playing now" beside it carries the meaning. */
  test("hides the decorative meter from assistive technology", async ({
    page,
  }) => {
    await page.setViewportSize(NARROW);
    await page.setContent(
      `<!doctype html><html><head><style>${await stylesheet()}</style></head><body>${LIVE_STRIP}</body></html>`,
    );
    await expect(page.locator(".playing-bars")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(page.getByText("Playing now")).toBeVisible();
  });

  for (const viewport of [NARROW, NARROWEST]) {
    test(`does not spill sideways at ${viewport.width}px`, async ({ page }) => {
      const { documentOverflow, widest } = await overflowOf(
        page,
        LIVE_STRIP,
        viewport,
      );
      expect(
        documentOverflow,
        `widest offender: ${widest}`,
      ).toBeLessThanOrEqual(0);
    });
  }

  /**
   * The date input and the precision select must never share a line on a phone.
   *
   * This is the fault Samah photographed: the date input painted straight
   * through the select beside it. It lives here, in a stylesheet harness, for a
   * specific reason — this file is the one the WebKit project can run. The
   * signed-in sweep cannot run there at all, because Clerk's development
   * instance is on a different origin and WebKit's cookie policy turns its
   * handshake into an endless redirect. Production's Clerk is first-party, so
   * that is a limitation of the test harness rather than a product defect, but
   * it does mean WebKit coverage has to come from markup that needs no session.
   *
   * Which is no loss: what WebKit uniquely reveals is intrinsic control widths
   * and native chrome, and both are pure CSS.
   */
  test("the date and precision fields stack rather than share a line on a phone", async ({
    page,
  }) => {
    await overflowOf(page, NOTE_EDITOR, NARROW);

    const boxes = await page.evaluate(() => {
      const at = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      };
      return { date: at("#d"), precision: at("#p") };
    });

    expect(
      boxes.date,
      "the date input should be in the harness",
    ).not.toBeNull();
    expect(
      boxes.precision,
      "the precision select should be in the harness",
    ).not.toBeNull();

    /**
     * Stacked, not merely "not currently overlapping" — and that distinction is
     * the whole point of this assertion.
     *
     * The first version of this test checked that the two boxes did not
     * intersect, and it **passed against the broken stylesheet**, because
     * headless WebKit's `<input type="date">` is narrower than the one on a
     * real iPhone. The overlap Samah photographed simply does not reproduce on
     * any engine available here, so testing for it tests nothing.
     *
     * What is reproducible is the rule that prevents it: below 34rem these two
     * fields get their own lines. That depends on a media query rather than on
     * anyone's intrinsic control width, so it holds identically in every engine
     * — and a stylesheet that lets them share a line on a phone fails here even
     * when nothing happens to collide in this particular browser.
     */
    const date = boxes.date!;
    const precision = boxes.precision!;
    expect(
      date.bottom <= precision.top + 1,
      `date ${JSON.stringify(date)} shares a line with precision ${JSON.stringify(precision)}`,
    ).toBe(true);
  });

  /**
   * A date field and the select beside it are one row, so they are one height.
   *
   * They were not: a native `<select>` is sized by the platform, and mobile
   * WebKit ignores author padding and `min-height` on one entirely — so the
   * "How sure" control rendered 25px shorter than the date field next to it in
   * landscape, while every desktop engine showed them matching. Fixed the same
   * way the date input was, by taking the widget's metrics away with
   * `appearance: none` and drawing the chevron ourselves.
   *
   * Measured in landscape, where they actually share a line.
   */
  test("the date field and the precision select are the same height", async ({
    page,
  }) => {
    await overflowOf(page, NOTE_EDITOR, { width: 874, height: 402 });

    const heights = await page.evaluate(() => {
      const h = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().height) : null;
      };
      return { date: h("#d"), precision: h("#p") };
    });

    expect(
      heights.date,
      "the date input should be in the harness",
    ).not.toBeNull();
    expect(
      heights.precision,
      "the precision select should be in the harness",
    ).not.toBeNull();
    expect(
      Math.abs(heights.date! - heights.precision!),
      `date is ${heights.date}px and the select beside it is ${heights.precision}px`,
    ).toBeLessThanOrEqual(1);
  });

  /**
   * The opened cover has to fit the screen it is opened on.
   *
   * It did not in landscape: the dialog was capped at `92vh` while the image
   * inside it was capped only in width, so on a phone turned sideways a square
   * cover rendered at its full 640px and ran off the bottom — taking the Close
   * button with it, on the one surface where Escape is not available because
   * there is no keyboard.
   *
   * Both orientations are checked, because portrait was fine throughout and
   * would have gone on passing a check that only looked there.
   */
  for (const [orientation, viewport] of [
    ["portrait", NARROW],
    ["landscape", { width: 874, height: 402 }],
  ] as const) {
    test(`the opened cover and its close button fit in ${orientation}`, async ({
      page,
    }) => {
      const square =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='640'%3E%3Crect width='640' height='640' fill='%23888'/%3E%3C/svg%3E";
      await overflowOf(
        page,
        `<dialog class="art-dialog" id="art"><img src="${square}" alt="cover">` +
          `<button class="art-dialog-close" id="close">Close</button></dialog>`,
        viewport,
      );
      await page.evaluate(() =>
        (document.querySelector("#art") as HTMLDialogElement).showModal(),
      );

      const box = await page.evaluate(() => {
        const dialog = document.querySelector("#art")!.getBoundingClientRect();
        const close = document.querySelector("#close")!.getBoundingClientRect();
        return {
          belowFold: Math.round(
            Math.max(0, dialog.bottom - window.innerHeight),
          ),
          pastRight: Math.round(Math.max(0, dialog.right - window.innerWidth)),
          closeVisible: close.bottom <= window.innerHeight && close.top >= 0,
        };
      });

      expect(box.belowFold, "the cover runs off the bottom of the screen").toBe(
        0,
      );
      expect(box.pastRight, "the cover runs off the side of the screen").toBe(
        0,
      );
      expect(box.closeVisible, "the close button is off-screen").toBe(true);
    });
  }

  /**
   * Tapping beside the cover closes it — in landscape too.
   *
   * It did not, and the reason was geometry rather than the handler.
   * `object-fit: contain` fits the *picture* inside the *box*; it does not
   * shrink the box. So in landscape a 640×314 `<img>` held a 314×314 cover with
   * 163px of transparent element on each side, and those strips belong to the
   * image — a tap there hit the image, not the backdrop. Portrait has no
   * letterbox, which is why the same code worked there and looked broken here.
   *
   * Asserted as "the image element is exactly the picture", because that is the
   * property the dismissal depends on, and it holds at any aspect ratio.
   */
  for (const [orientation, viewport] of [
    ["portrait", NARROW],
    ["landscape", { width: 874, height: 402 }],
  ] as const) {
    test(`the cover has no dead margin to tap in ${orientation}`, async ({
      page,
    }) => {
      const square =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='640'%3E%3Crect width='640' height='640' fill='%23888'/%3E%3C/svg%3E";
      await overflowOf(
        page,
        `<dialog class="art-dialog" id="art"><img id="pic" src="${square}" alt="cover">` +
          `<button class="art-dialog-close">Close</button></dialog>`,
        viewport,
      );
      await page.evaluate(() =>
        (document.querySelector("#art") as HTMLDialogElement).showModal(),
      );

      const gap = await page.evaluate(() => {
        const img = document.querySelector("#pic") as HTMLImageElement;
        const box = img.getBoundingClientRect();
        const scale = Math.min(
          box.width / img.naturalWidth,
          box.height / img.naturalHeight,
        );
        return {
          sides: Math.round((box.width - img.naturalWidth * scale) / 2),
          topAndBottom: Math.round(
            (box.height - img.naturalHeight * scale) / 2,
          ),
        };
      });

      expect(
        gap.sides,
        "dead image margin beside the cover swallows the tap",
      ).toBe(0);
      expect(
        gap.topAndBottom,
        "dead image margin above the cover swallows the tap",
      ).toBe(0);
    });
  }

  /**
   * The per-track options button is placed by the layout, not by a font.
   *
   * It was a text "⋯" in a padded block, so the character's own metrics decided
   * where it sat inside its own button — and those metrics come from whichever
   * font the platform resolves. Headless WebKit centres it perfectly, which is
   * exactly why measuring it here proved nothing about an iPhone; this is the
   * same class of fault as the date input the UA was sizing.
   *
   * Drawing the glyph removes the variable, and the assertion is on the things
   * that hold in every engine: a square target at the row's right edge with its
   * icon centred by flexbox.
   */
  test("the track options button is a centred, square, right-aligned target", async ({
    page,
  }) => {
    const dots =
      '<svg aria-hidden="true"><circle cx="5" cy="12" r="1.9" fill="currentColor"/>' +
      '<circle cx="12" cy="12" r="1.9" fill="currentColor"/>' +
      '<circle cx="19" cy="12" r="1.9" fill="currentColor"/></svg>';
    await overflowOf(
      page,
      '<ol class="tracklist"><li class="track"><div class="track-line">' +
        '<span class="track-num note">1</span>' +
        '<div class="track-main"><div class="track-title">CN TOWER</div></div>' +
        `<button class="track-more" id="more" aria-label="Options">${dots}</button>` +
        "</div></li></ol>",
      NARROW,
    );

    const box = await page.evaluate(() => {
      const row = document
        .querySelector(".track-line")!
        .getBoundingClientRect();
      const button = document.querySelector("#more")!.getBoundingClientRect();
      const icon = document.querySelector("#more svg")!.getBoundingClientRect();
      return {
        offRowCentre: Math.round(
          button.top + button.height / 2 - (row.top + row.height / 2),
        ),
        iconOffCentreX: Math.round(
          icon.left + icon.width / 2 - (button.left + button.width / 2),
        ),
        iconOffCentreY: Math.round(
          icon.top + icon.height / 2 - (button.top + button.height / 2),
        ),
        fromRowRight: Math.round(row.right - button.right),
        width: Math.round(button.width),
        height: Math.round(button.height),
      };
    });

    expect(
      Math.abs(box.offRowCentre),
      "the button is off the row's centre line",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(box.iconOffCentreX),
      "the icon is off-centre in its button",
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(box.iconOffCentreY),
      "the icon is off-centre in its button",
    ).toBeLessThanOrEqual(1);
    expect(
      box.fromRowRight,
      "the button is not at the row's right edge",
    ).toBeLessThanOrEqual(1);
    // A square, and a real tap target rather than whatever a glyph happened to
    // measure — it was 39px wide before.
    expect(box.width).toBe(box.height);
    expect(box.width).toBeGreaterThanOrEqual(44);
  });

  /**
   * Native control chrome has to be painted for the theme the page is wearing.
   *
   * A select's chevron, a date picker and a checkbox tick are drawn by the UA
   * and read nothing from the stylesheet. Without a `color-scheme` declaration
   * the UA assumes a light page, which is how the sort dropdowns ended up with
   * black chevrons on a near-black background.
   */
  test("declares a colour scheme, so native controls are not painted for a light page", async ({
    page,
  }) => {
    await overflowOf(page, NOTE_EDITOR, NARROW);
    const declared = await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    );
    expect(declared, "‽ :root must declare color-scheme").toMatch(/dark/);
  });
});
