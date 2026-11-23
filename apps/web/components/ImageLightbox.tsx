"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useRef, useState } from "react";
import { Icon } from "./Icon";

interface Props {
  src: string;
  alt: string;
  caption?: string;
  onClose: () => void;
  /** A short-lived signed URL expired. The caller fetches a fresh one. */
  onError?: () => void;
}

export function ImageLightbox({ src, alt, caption, onClose, onError }: Props) {
  const [actualSize, setActualSize] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        aria-modal="true"
        aria-describedby={undefined}
        showCloseButton={false}
        overlayClassName="z-[70] bg-black/82 backdrop-blur-sm"
        className="inset-0 z-[70] flex h-dvh w-full max-w-none translate-none flex-col gap-0 rounded-none bg-transparent p-0 text-(--ink-text) ring-0 sm:max-w-none"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current = document.activeElement as HTMLElement | null;
          closeButton.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <div className="flex items-center gap-2 px-4 py-2.5">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm">{caption ?? alt}</DialogTitle>
          <Button variant="ghost" className="border-white/20 bg-white/8 text-(--ink-text) hover:bg-white/18 hover:text-(--ink-text)" type="button" aria-pressed={actualSize} onClick={() => setActualSize((value) => !value)}>
            {actualSize ? "Fit to width" : "Actual size"}
          </Button>
          <DialogClose asChild>
            <Button ref={closeButton} variant="ghost" size="icon" className="border-white/20 bg-white/8 text-(--ink-text) hover:bg-white/18 hover:text-(--ink-text)" type="button" aria-label="Close">
              <Icon name="x" />
            </Button>
          </DialogClose>
        </div>
        <div data-slot="lightbox-stage" className="min-h-0 flex-1 overflow-auto px-4 pb-4 text-center" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
          <img
            src={src}
            alt={alt}
            className={cn("inline-block h-auto rounded-sm bg-white align-top", actualSize ? "max-w-none cursor-zoom-out" : "max-w-full cursor-zoom-in")}
            onClick={() => setActualSize((value) => !value)}
            onError={onError}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
