"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";

import { Link, usePathname } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { messagesHref, UNREAD_EVENT } from "@/lib/messages";

import { Icon } from "./Icon";

const POLL_MS = 30_000;

/** The Messages icon beside the bell: how many chats have something unread, checked every 30
 * seconds while the tab is visible and right away when Messages says something changed. */
export function MessagesIcon() {
  const t = useTranslations("messages");
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const active = pathname.startsWith("/messages");

  const load = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    const { data } = await api.GET("/chats/unread").catch(() => ({ data: undefined }));
    if (data) setCount(data.chats);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), POLL_MS);
    document.addEventListener("visibilitychange", load);
    window.addEventListener(UNREAD_EVENT, load);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener(UNREAD_EVENT, load);
    };
  }, [load]);

  return (
    <Link
      href={messagesHref()}
      aria-label={count > 0 ? t("openUnread", { count }) : t("open")}
      aria-current={active ? "page" : undefined}
      className={`press relative flex h-11 w-10 items-center justify-center rounded-full after:absolute after:inset-y-0 after:-inset-x-0.5 sm:after:hidden sm:w-11 hover:text-fg ${active ? "text-fg" : "text-muted"}`}
    >
      <Icon name="chat" />
      {count > 0 && (
        <span
          aria-hidden="true"
          className="absolute right-0 top-0 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-4 text-on-accent"
        >
          {count > 9 ? "9+" : count}
        </span>
      )}
    </Link>
  );
}
