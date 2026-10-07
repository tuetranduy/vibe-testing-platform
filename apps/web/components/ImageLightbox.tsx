"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

interface Props {
  src: string;
  alt: string;
  /** Shown above the image (what it is and when it was taken). */
  caption?: string;
  onClose: () => void;
  /** The image failed to load (a short-lived signed URL expired): the caller fetches a fresh one. */
  onError?: () => void;
}

/**
 * A screenshot at full size, over the page instead of in a new tab. Fit to width by default (full-page screenshots
 * are tall: they scroll), or at actual size. Escape, the close button or a click outside the image closes it; focus
 * goes back to where it was, and the page behind does not scroll while it is open.
 */
export function ImageLightbox({ src, alt, caption, onClose, onError }: Props) {
  const [actualSize, setActualSize] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  // The latest onClose, so the effect below runs once per opening (it saves and restores focus).
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const returnFocus = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      returnFocus?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="lightbox-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={caption ?? alt} className="lightbox">
        <div className="lightbox-bar">
          <p className="lightbox-caption">{caption ?? alt}</p>
          <button type="button" className="lightbox-button" aria-pressed={actualSize} onClick={() => setActualSize((a) => !a)}>
            {actualSize ? "Fit to width" : "Actual size"}
          </button>
          <button ref={closeButton} type="button" className="lightbox-button" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="lightbox-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          {/* Short-lived signed URL: an error means it expired, so the caller fetches a fresh one. */}
          <img
            src={src}
            alt={alt}
            className={actualSize ? "lightbox-image lightbox-image-actual" : "lightbox-image"}
            onClick={() => setActualSize((a) => !a)}
            onError={onError}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
