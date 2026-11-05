"use client";

import type { ReactNode } from "react";

import { useTvFocus } from "./useTvFocus";

type Variant = "primary" | "secondary";

type Props = {
  onPress: () => void;
  variant?: Variant;
  focusKey?: string;
  disabled?: boolean;
  /** Pressed state for a toggle (a status chip, a language). */
  selected?: boolean;
  className?: string;
  children: ReactNode;
};

// TV pills: 72px tall and 28px type, readable from the couch. Focus grows the pill; the primary
// and a selected chip are filled, so focus rings them, while an outline pill lights its border.
const base =
  "inline-flex min-h-[4.5rem] items-center justify-center gap-3 rounded-full border-2 px-10 text-[1.75rem] font-bold outline-[3px] outline-offset-4 outline-solid transition-transform duration-[160ms] ease-out disabled:opacity-50";

export function tvButtonClass(variant: Variant, focused: boolean, selected = false) {
  const filled = variant === "primary" || selected;
  const look = filled
    ? "border-accent bg-accent text-on-accent"
    : focused
      ? "border-accent bg-surface text-fg"
      : "border-line-strong text-fg";
  const ring = focused && filled ? "outline-accent" : "outline-transparent";
  return `${base} ${look} ${ring} ${focused ? "scale-[1.06]" : ""}`;
}

export function TvButton({ onPress, variant = "secondary", focusKey, disabled, selected, className = "", children }: Props) {
  const { ref, focused } = useTvFocus<HTMLButtonElement>({ focusKey, onEnter: () => !disabled && onPress() });
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onPress}
      className={`${tvButtonClass(variant, focused, selected)} ${className}`}
    >
      {children}
    </button>
  );
}
