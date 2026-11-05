"use client";

import type { ReactNode } from "react";

import { Link, useRouter } from "@/i18n/navigation";

import { useTvFocus } from "./useTvFocus";

type Props = {
  href: string;
  focusKey?: string;
  className?: string;
  label?: string;
  children: ReactNode;
};

/**
 * A link the remote can reach. It carries `data-focused` so its contents style themselves with
 * group-data-[focused=true]: classes (the contents can be server-rendered).
 */
export function TvLink({ href, focusKey, className = "", label, children }: Props) {
  const router = useRouter();
  const { ref, focused } = useTvFocus<HTMLAnchorElement>({ focusKey, onEnter: () => router.push(href) });
  return (
    <Link ref={ref} href={href} aria-label={label} data-focused={focused} className={`group block outline-none ${className}`}>
      {children}
    </Link>
  );
}
