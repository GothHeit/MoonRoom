"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { Link, usePathname } from "@/i18n/navigation";
import { APP_NAME } from "@/lib/brand";

import { LocaleSwitcher } from "./LocaleSwitcher";
import { Logo } from "./Logo";
import { NotificationBell } from "./NotificationBell";
import { ModeSwitch } from "./ModeSwitch";
import { isActive, modeOf, navItemsFor } from "./nav-items";
import { SearchBox } from "./SearchBox";
import type { AvatarInfo } from "@/lib/avatar";

import { UserMenu } from "./UserMenu";

/** Flat bar on the page color; a hairline shows up once the page scrolls. */
export function TopNav({ userId, username, avatar, isAdmin, pending = 0 }: { userId: string; username: string; avatar: AvatarInfo; isAdmin: boolean; pending?: number }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const mode = modeOf(pathname);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      data-scrolled={scrolled}
      className={`fixed inset-x-0 top-0 z-40 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] border-b bg-bg transition-colors ${scrolled ? "border-line" : "border-transparent"}`}
    >
      <nav aria-label={t("main")} className="flex h-16 items-center gap-3 px-4 sm:h-20 sm:gap-6 sm:px-8 lg:gap-8">
        <Link href={mode === "manga" ? "/manga" : "/"} aria-label={APP_NAME} className="shrink-0">
          <Logo />
        </Link>
        <ModeSwitch mode={mode} />
        <ul className="hidden items-center gap-6 md:flex">
          {navItemsFor(mode).map(({ href, key }) => {
            const active = isActive(pathname, href);
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`border-b py-1 text-sm font-medium transition-colors hover:text-fg ${active ? "border-accent text-fg" : "border-transparent text-muted"}`}
                >
                  {t(key)}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="ml-auto flex items-center gap-3">
          <div className="hidden md:block">
            <SearchBox mode={mode} />
          </div>
          <NotificationBell />
          <div className="hidden md:block">
            <LocaleSwitcher />
          </div>
          <div className="hidden md:block">
            <UserMenu userId={userId} username={username} avatar={avatar} isAdmin={isAdmin} pending={pending} />
          </div>
        </div>
      </nav>
    </header>
  );
}
