import type { ComponentProps } from "react";

import { Link } from "@/i18n/navigation";

type Variant = "primary" | "secondary" | "ghost";

// Pills, 44px tall so they are easy to hit on a phone.
const base =
  "press inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent/85",
  secondary: "border border-line-strong text-fg hover:border-accent",
  ghost: "text-muted hover:bg-surface hover:text-fg",
};

function buttonClass(variant: Variant = "primary", className = "") {
  return `${base} ${variants[variant]} ${className}`.trim();
}

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: Variant }) {
  return <button type={type} className={buttonClass(variant, className)} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant }) {
  return <Link className={buttonClass(variant, className)} {...props} />;
}
