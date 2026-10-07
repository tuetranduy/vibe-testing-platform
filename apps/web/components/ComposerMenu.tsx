"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
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

/**
 * A chip in the requirement box's toolbar that opens a listbox (the model, the reasoning level, the actions mode),
 * like the pickers in Claude Code's prompt box. Keyboard: ArrowDown / Enter / Space open it on the selected option;
 * arrows, Home and End move (skipping disabled options), Enter or Space choose, Escape and Tab close. A click
 * outside closes it too.
 */
export function ComposerMenu<V extends string>({ id, label, icon, value, display, options, onChange, tone, disabled, invalid, describedBy, align = "start" }: Props<V>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-o${i}`;

  const enabled = (i: number) => options[i] !== undefined && !options[i]!.disabled;
  const step = (from: number, by: 1 | -1) => {
    for (let i = from + by; i >= 0 && i < options.length; i += by) if (enabled(i)) return i;
    return from;
  };
  const first = () => step(-1, 1);
  const last = () => step(options.length, -1);

  const show = () => {
    const selected = options.findIndex((o) => o.value === value);
    setActive(selected >= 0 && enabled(selected) ? selected : first());
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };
  const choose = (i: number) => {
    if (!enabled(i)) return;
    onChange(options[i]!.value);
    close(true);
  };

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]); // optionId is stable for the component's life

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      show();
    }
  };
  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const moves: Record<string, () => number> = {
      ArrowDown: () => step(active, 1),
      ArrowUp: () => step(active, -1),
      Home: first,
      End: last,
    };
    if (moves[e.key]) {
      e.preventDefault();
      setActive(moves[e.key]!());
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  // Options in groups, keeping each option's index (the listbox's order is the options' order).
  const groups: { name: string | undefined; items: number[] }[] = [];
  options.forEach((o, i) => {
    const prev = groups.at(-1);
    if (prev && prev.name === o.group) prev.items.push(i);
    else groups.push({ name: o.group, items: [i] });
  });
  const renderOption = (i: number) => {
    const o = options[i]!;
    const selected = o.value === value;
    return (
      <li
        key={i}
        id={optionId(i)}
        role="option"
        aria-selected={selected}
        aria-disabled={o.disabled ? true : undefined}
        aria-labelledby={`${optionId(i)}-label`}
        aria-describedby={o.hint ? `${optionId(i)}-hint` : undefined}
        className={`composer-option${i === active ? " is-active" : ""}`}
        onMouseEnter={() => enabled(i) && setActive(i)}
        onClick={() => choose(i)}
      >
        <span className="composer-option-check" aria-hidden="true">
          {selected && <Icon name="check" />}
        </span>
        <span className="composer-option-text">
          <span id={`${optionId(i)}-label`} className="composer-option-label">
            {o.label}
          </span>
          {o.hint && (
            <span id={`${optionId(i)}-hint`} className="composer-option-hint">
              {o.hint}
            </span>
          )}
        </span>
      </li>
    );
  };

  return (
    <div className="composer-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        className={`composer-chip${tone === "warning" ? " composer-chip-warning" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${display}`}
        title={label}
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onButtonKey}
      >
        <Icon name={icon} />
        <span className="composer-chip-text">{display}</span>
        <Icon name="chevron" className="composer-chip-chevron" />
      </button>
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          aria-activedescendant={optionId(active)}
          tabIndex={-1}
          className={`composer-popover composer-popover-${align}`}
          onKeyDown={onListKey}
        >
          {groups.map((g, gi) =>
            g.name === undefined ? (
              g.items.map(renderOption)
            ) : (
              <li key={`g${gi}`} role="presentation">
                <span className="composer-group-label" aria-hidden="true">
                  {g.name}
                </span>
                <ul role="group" aria-label={g.name}>
                  {g.items.map(renderOption)}
                </ul>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
