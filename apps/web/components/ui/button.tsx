import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[9px] border border-transparent text-sm leading-[1.2] font-[550] tracking-[-0.005em] whitespace-nowrap no-underline touch-manipulation transition focus-visible:outline-2 active:enabled:translate-y-px disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-[image:var(--primary-gradient)] text-primary-foreground shadow-[0_3px_8px_rgb(50_78_190_/_0.12)] hover:bg-[image:var(--primary-gradient-hover)] hover:text-primary-foreground",
        outline: "border-input bg-secondary text-secondary-foreground hover:border-(--text-subtle) hover:bg-(--surface-hover) hover:text-foreground",
        ghost: "text-muted-foreground hover:bg-muted hover:text-foreground",
        destructive: "bg-(--danger-solid) text-(--danger-contrast) hover:bg-(--danger-hover)",
        "danger-outline": "border-input bg-card text-destructive hover:border-(--danger-border) hover:bg-(--danger-bg)",
        "danger-ghost": "text-destructive hover:bg-(--danger-bg)",
        "on-ink": "bg-(--ink-text) text-(--ink) hover:bg-white hover:text-(--ink)",
      },
      size: {
        default: "min-h-[38px] px-[15px] py-2",
        lg: "min-h-[46px] px-[22px] py-3",
        xs: "min-h-6 gap-1 px-2 text-xs",
        sm: "min-h-7 gap-1 px-2.5 text-xs",
        icon: "size-8",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
      block: {
        true: "flex w-full text-center whitespace-normal",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  block,
  ...props
}: React.ComponentProps<"button"> &
  Omit<VariantProps<typeof buttonVariants>, "variant"> & {
    variant?: NonNullable<VariantProps<typeof buttonVariants>["variant"]> | "plain";
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={variant === "plain" ? className : cn(buttonVariants({ variant, size, block }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants }
