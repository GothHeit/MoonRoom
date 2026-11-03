"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";

import { Icon } from "./Icon";
import { isActive, modeOf, navItemsFor, searchHrefFor } from "./nav-items";
import type { AvatarInfo } from "@/lib/avatar";

import { UserMenu } from "./UserMenu";

const item = "press flex min-h-14 short:min-h-11 flex-1 flex-col short:flex-row items-center justify-center gap-1 short:gap-2 text-xs font-medium active:opacity-70";

/** Phone navigation: Home, Browse, My list, Search, You. */
export function TabBar({ userId, username, avatar, isAdmin, pending = 0 }: { userId: string; username: string; avatar: AvatarInfo; isAdmin: boolean; pending?: number }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const mode = modeOf(pathname);
  const tabs = [...navItemsFor(mode), { href: searchHrefFor(mode), key: "search" as const, icon: "search" as const }];

  return (
    <nav
      aria-label={t("main")}
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden short:flex"
    >
      {tabs.map(({ href, key, icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`${item} ${active ? "text-accent" : "text-muted"}`}
          >
            <Icon name={icon} />
            {t(key)}
          </Link>
        );
      })}
      <div className="flex flex-1 justify-center">
        <UserMenu
          userId={userId}
          username={username}
          avatar={avatar}
          isAdmin={isAdmin} pending={pending}
          variant="tab"
          triggerClassName={`${item} h-full w-full text-muted`}
          trigger={
            <>
              <Icon name="you" />
              {t("you")}
            </>
          }
        />
      </div>
    </nav>
  );
}
