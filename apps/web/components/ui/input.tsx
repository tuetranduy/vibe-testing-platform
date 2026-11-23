import * as React from "react"
import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-h-11 w-full min-w-0 rounded-md border border-input bg-(--surface-sunken) px-3.5 py-2.5 text-[0.9375rem] text-foreground shadow-[inset_0_1px_2px_rgb(0_0_0_/_0.12)] transition-[border-color,box-shadow] placeholder:text-(--text-subtle) hover:border-(--text-subtle) focus-visible:border-ring focus-visible:outline-transparent focus-visible:ring-4 focus-visible:ring-(--ring) disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
