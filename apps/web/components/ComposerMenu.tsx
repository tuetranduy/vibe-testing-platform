"use client";

import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useId } from "react";
import { Icon, type IconName } from "./Icon";

export interface MenuOption<V extends string> {
  value: V;
  label: string;
  /** A second line under the label (its accessible description). */
  hint?: string;
  disabled?: boolean;
  /** Options with the same group are listed under it, in order of first appearance. */
  group?: string;
}

interface Props<V extends string> {
  /** The chip's id: the form's error key, so a field error can focus it. */
  id: string;
  /** What the menu sets ("Model"): the listbox's name and the start of the chip's. */
  label: string;
  icon: IconName;
  value: V;
  /** What the chip shows for the current value. */
  display: string;
  options: readonly MenuOption<V>[];
  onChange(value: V): void;
  /** "warning": the chip is coloured to say the choice is risky (destructive actions allowed). */
  tone?: "warning";
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Which edge of the chip the menu lines up with. */
  align?: "start" | "end";
}

/** A single-choice picker for the composer toolbar. */
export function ComposerMenu<V extends string>({ id, label, icon, value, display, options, onChange, tone, disabled, invalid, describedBy, align = "start" }: Props<V>) {
  const labelId = useId();
  const groups: { name: string | undefined; options: MenuOption<V>[] }[] = [];
  for (const option of options) {
    const group = groups.at(-1);
    if (group && group.name === option.group) group.options.push(option);
    else groups.push({ name: option.group, options: [option] });
  }

  // Radix reserves the empty string for its placeholder. The default model uses an empty value.
  const itemValue = (optionValue: V) => `option:${optionValue}`;
  const renderOption = (option: MenuOption<V>) => (
    <SelectItem
      key={option.value}
      value={itemValue(option.value)}
      textValue={option.label}
      aria-labelledby={`${labelId}-${option.value}-label`}
      aria-describedby={option.hint ? `${labelId}-${option.value}-hint` : undefined}
      disabled={option.disabled}
    >
      <span className="flex min-w-0 flex-col gap-px">
        <span id={`${labelId}-${option.value}-label`}>{option.label}</span>
        {option.hint && <span id={`${labelId}-${option.value}-hint`} className="text-xs leading-snug text-muted-foreground">{option.hint}</span>}
      </span>
    </SelectItem>
  );

  return (
    <Select
      value={itemValue(value)}
      disabled={disabled}
      onValueChange={(next) => {
        const option = options.find((candidate) => itemValue(candidate.value) === next);
        if (option) onChange(option.value);
      }}
    >
      <SelectTrigger
        id={id}
        aria-label={`${label}: ${display}`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        title={label}
        className={cn(
          "min-w-0 max-w-full",
          tone === "warning" && "border-(--warning-border) bg-(--warning-bg) text-(--warning) hover:bg-(--warning-bg) hover:text-(--warning) dark:bg-(--warning-bg)"
        )}
      >
        <Icon name={icon} />
        <span className="truncate">{display}</span>
      </SelectTrigger>
      <SelectContent
        position="popper"
        align={align}
        aria-label={label}
        className="min-w-48 max-w-[min(340px,calc(100vw-32px))]"
      >
        {groups.map((group, index) => group.name ? (
          <SelectGroup key={index} aria-label={group.name}>
            <SelectLabel>{group.name}</SelectLabel>
            {group.options.map(renderOption)}
          </SelectGroup>
        ) : group.options.map(renderOption))}
      </SelectContent>
    </Select>
  );
}
