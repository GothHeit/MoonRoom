"use client";

import type { ReactNode } from "react";

import { Link, useRouter } from "@/i18n/navigation";

import { tvButtonClass } from "./TvButton";
import { useTvFocus } from "./useTvFocus";

type Props = {
  href: string;
  variant?: "primary" | "secondary";
  focusKey?: string;
  children: ReactNode;
};

/** A pill that goes somewhere (Play, a title page). */
export function TvPillLink({ href, variant = "primary", focusKey, children }: Props) {
  const router = useRouter();
  const { ref, focused } = useTvFocus<HTMLAnchorElement>({ focusKey, onEnter: () => router.push(href) });
  return (
    <Link ref={ref} href={href} className={tvButtonClass(variant, focused)}>
      {children}
    </Link>
  );
}
