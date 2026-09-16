"use client";

import { useRef, useState } from "react";
import { safeArtwork } from "@/lib/music/artwork";

/**
 * Cover art, rendered as a plain `<img>` on purpose.
 *
 * `next/image` would route every provider image through this server's optimizer
 * — fetching, re-encoding and caching it on a 2 GB droplet that also runs
 * MKDb's PostgreSQL. That is rehosting by another name, and rehosting is the
 * exact cost we avoid by storing links (see lib/music/artwork.ts). The provider
 * CDNs are already fast, already cached at the edge, and already sized.
 *
 * `safeArtwork` is applied here rather than at every call site, so a URL from
 * an untrusted source can never become a tracking beacon because one page
 * forgot to check it.
 *
 * **Thumbnails are fetched larger than they are drawn.** A 56px slot on a 3x
 * phone needs a ~170px source; the 64px rendition this used to request looked
 * soft on every handset. `fullUrl` is separate so tapping a thumbnail can open
 * the real cover without a second lookup.
 */
export function CoverArt({
  url,
  fullUrl,
  size,
  alt = "",
  className,
  title,
}: {
  url: string | null | undefined;
  /** The large rendition, shown when the art is opened. Defaults to `url`. */
  fullUrl?: string | null;
  size: number;
  /** Empty by default: next to a title and artist, the cover adds nothing a
   *  screen reader needs to hear. */
  alt?: string;
  className?: string;
  /** What the art is of — used for the dialog's accessible name. */
  title?: string;
}) {
  const src = safeArtwork(url);
  const large = safeArtwork(fullUrl) ?? src;
  const classes = ["cover", className].filter(Boolean).join(" ");

  if (!src) {
    return (
      <span
        className={`${classes} cover-empty`}
        style={coverSize(size)}
        aria-hidden="true"
      />
    );
  }

  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- see the note above
    <img
      className={classes}
      src={src}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      // Cover art is decorative and cross-origin; there is no reason to tell a
      // provider's CDN which page of ours the viewer is on.
      referrerPolicy="no-referrer"
    />
  );

  /**
   * Always openable when there is art at all, even when the thumbnail and the
   * full rendition are the same URL. A 56px square blown up to fill the screen
   * is the point of the gesture; refusing it because we happen to be showing
   * one file at two sizes would be a technicality the person tapping does not
   * share.
   */
  return <ArtworkButton image={image} src={large ?? src} title={title} size={size} />;
}

/**
 * The size as a custom property rather than as `width` and `height`.
 *
 * **An inline style cannot be overridden by a stylesheet**, and that is not a
 * style preference here — it was a bug. The collection sheet enlarges a track's
 * cover on narrow screens, and its rule could resize the `<img>` but never the
 * `<button>` wrapping it, because the button's size arrived inline. The image
 * grew to 224px inside a button still 200px tall, so 24px of artwork hung out
 * of the bottom of its own box and printed over the track title beneath it.
 *
 * A custom property carries the default *into* the cascade instead of above it,
 * so a rule with a plain selector can change it and the button and the image
 * stay the same size.
 */
function coverSize(size: number): React.CSSProperties {
  return { ["--cover-size" as string]: `${size}px` } as React.CSSProperties;
}

function ArtworkButton({
  image,
  src,
  title,
  size,
}: {
  image: React.ReactNode;
  src: string;
  title?: string;
  size: number;
}) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  function show() {
    setOpen(true);
    dialog.current?.showModal();
  }

  function hide() {
    dialog.current?.close();
    setOpen(false);
  }

  /**
   * Anywhere outside the cover closes it.
   *
   * A modal `<dialog>` is sized to its contents, and a click on the backdrop
   * reports the **dialog element itself** as the target — the `::backdrop`
   * pseudo-element is not in the DOM and cannot be clicked. So comparing the
   * target against the dialog distinguishes "outside the picture" from "on the
   * picture" without wrapping anything in an extra layer.
   *
   * Escape already worked, being native. This is the gesture everyone actually
   * reaches for, and being forced to hit a specific button to dismiss a
   * full-screen image is the kind of small rudeness people remember.
   */
  function onDialogClick(event: React.MouseEvent<HTMLDialogElement>) {
    if (event.target === dialog.current) hide();
  }

  return (
    <>
      <button
        type="button"
        className="cover-button"
        style={coverSize(size)}
        onClick={show}
        aria-label={title ? `See the cover for ${title}` : "See the full-size cover"}
      >
        {image}
      </button>

      {/*
        A native <dialog>, so Escape, the backdrop, focus trapping and the top
        layer all come from the platform rather than from a scroll-lock hack.
        The image is only mounted while open — a list of fifty tracks must not
        eagerly fetch fifty 640px covers for dialogs nobody opened.
      */}
      <dialog
        ref={dialog}
        className="art-dialog"
        onClose={() => setOpen(false)}
        onClick={onDialogClick}
      >
        {open && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
            <img
              src={src}
              alt={title ? `Cover art for ${title}` : "Cover art"}
              referrerPolicy="no-referrer"
            />
            {/*
              Focused on open, which is what stops the browser focusing — and
              outlining — the dialog box itself. Keyboard users land on the one
              control here instead of on an invisible container.
            */}
            <button type="button" className="art-dialog-close" onClick={hide} autoFocus>
              Close
            </button>
          </>
        )}
      </dialog>
    </>
  );
}
