"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ReactNode } from "react";
import { Icon } from "./Icon";

/** Signed artifact URLs and images load only after the disclosure opens. */
export function Disclosure({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <Collapsible asChild>
      <Card as="section" className="group overflow-hidden p-0 max-[560px]:p-0">
        <h2>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between rounded-none px-5 py-4 text-base text-foreground">
              {title}
              <Icon name="chevron" className="text-muted-foreground transition-transform group-data-open:rotate-90" />
            </Button>
          </CollapsibleTrigger>
        </h2>
        {hint && <p className="px-5 pb-4 text-sm text-muted-foreground group-data-open:hidden">{hint}</p>}
        <CollapsibleContent className="border-t border-border px-5 py-4">{children}</CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
