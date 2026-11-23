import { createElement, type ComponentProps } from "react";
import { cn } from "@/lib/utils";

type FieldElement = "div" | "fieldset";

function Field<T extends FieldElement = "div">({
  as,
  className,
  ...props
}: ComponentProps<T> & { as?: T }) {
  return createElement(as ?? "div", {
    ...props,
    "data-slot": "field",
    className: cn(
      "m-0 flex min-w-0 flex-col gap-2 border-0 p-0 [&>label]:text-sm [&>label]:font-semibold [&>legend]:mb-2 [&>legend]:text-sm [&>legend]:font-semibold",
      className,
    ),
  });
}

export { Field };
