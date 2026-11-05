"use client";

import { FocusContext, useFocusable } from "@noriginmedia/norigin-spatial-navigation";
import Image from "next/image";
import { useTranslations } from "next-intl";

import { Avatar } from "@/components/ui/Avatar";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import type { AvatarInfo } from "@/lib/avatar";
import { APP_NAME } from "@/lib/brand";

import { NAV_KEY } from "./spatial";
import { useTvFocus } from "./useTvFocus";

const TABS = [
  { href: "/tv", key: "home" },
  { href: "/tv/search", key: "search" },
  { href: "/tv/list", key: "list" },
  { href: "/tv/settings", key: "settings" },
] as const;

function Tab({ href, label, active }: { href: string; label: string; active: boolean }) {
  const router = useRouter();
  const { ref, focused } = useTvFocus<HTMLAnchorElement>({
    focusKey: `tv-tab-${href}`,
    remember: false,
    onEnter: () => router.push(href),
    // The bar sits above everything: up has nowhere to go.
    onArrow: (direction) => direction !== "up",
  });
  return (
    <Link
      ref={ref}
      href={href}
      aria-current={active ? "page" : undefined}
      className={`relative inline-flex min-h-[4rem] items-center rounded-full px-7 text-[1.75rem] font-bold outline-[3px] outline-offset-2 outline-solid outline-transparent transition-transform duration-[160ms] ease-out ${
        focused ? "scale-[1.06] bg-surface text-fg outline-accent" : active ? "text-fg" : "text-muted"
      }`}
    >
      {label}
      {active && <span aria-hidden="true" className="absolute inset-x-7 bottom-2 h-0.5 rounded-full bg-accent" />}
    </Link>
  );
}

type Props = { userId: string; username: string; avatar: AvatarInfo };

/** The TV's top bar: logo, the four screens, and who is signed in. Flat and always solid. */
export function TvNav({ userId, username, avatar }: Props) {
  const t = useTranslations("tv.nav");
  const pathname = usePathname();
  // A title page belongs to no tab; Home stays lit so the bar still says where you are.
  const current = TABS.find((tab) => tab.href !== "/tv" && pathname.startsWith(tab.href))?.href ?? "/tv";
  // Coming up into the bar lands on the screen you are on.
  const { ref, focusKey } = useFocusable({ focusKey: NAV_KEY, preferredChildFocusKey: `tv-tab-${current}`, trackChildren: true });
  return (
    <FocusContext.Provider value={focusKey}>
      <header
        ref={ref}
        data-tv-nav
        className="fixed inset-x-0 top-0 z-20 flex h-[7.5rem] items-center gap-12 border-b border-line bg-bg px-[var(--tv-x)]"
      >
        <Image src="/logo-lockup.svg" alt={APP_NAME} width={208} height={50} unoptimized priority className="h-[3.125rem] w-auto" />
        <nav aria-label={t("label")} className="flex items-center gap-2">
          {TABS.map((tab) => (
            <Tab key={tab.href} href={tab.href} label={t(tab.key)} active={current === tab.href} />
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4 text-[1.5rem] text-muted">
          <span className="max-w-[18rem] truncate">{username}</span>
          <Avatar userId={userId} username={username} avatar={avatar} size={48} />
        </div>
      </header>
    </FocusContext.Provider>
  );
}
