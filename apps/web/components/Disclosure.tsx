"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useId, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * A collapsible card section. Its content is mounted only while open, so anything expensive inside
 * (signed artifact URLs, images) loads only when the user asks for it.
 */
export function Disclosure({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Card as="section" className="disclosure">
      <h2 className="disclosure-heading">
        <Button variant="plain"
          type="button"
          className="disclosure-toggle"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <span>{title}</span>
          <Icon name="chevron" className="disclosure-chevron" />
        </Button>
      </h2>
      {hint && !open && <p className="muted disclosure-hint">{hint}</p>}
      {open && (
        <div id={id} className="disclosure-body">
          {children}
        </div>
      )}
    </Card>
  );
}
