"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { Avatar } from "@/components/ui/Avatar";
import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { profileHref } from "@/lib/friends";
import { usePresence } from "@/lib/use-presence";
import type { components } from "@app/api-client";

import { Icon } from "./Icon";

type Item = components["schemas"]["NotificationOut"];

const POLL_MS = 30_000;

function hrefOf(item: Item) {
  switch (item.kind) {
    case "friend_request":
      return "/friends";
    case "friend_accepted":
      return item.actor ? profileHref(item.actor.id) : "/friends";
    case "room_invite":
      return item.room_active && item.room_code ? `/room/${item.room_code}` : null;
    case "new_chapter":
      return item.manga_id ? `/manga/${item.manga_id}` : null;
    default:
      return item.anime_id ? `/anime/${item.anime_id}` : null;
  }
}

/** The bell in the header: an unread badge and a list of what happened, checked every 30 seconds
 * while the tab is visible. */
export function NotificationBell() {
  const t = useTranslations("notifications");
  const format = useFormatter();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // Bumped on every local change, so a poll that started earlier can't undo it.
  const changes = useRef(0);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (document.visibilityState !== "visible") return;
    const seen = changes.current;
    const { data } = await api.GET("/notifications").catch(() => ({ data: undefined }));
    if (seen !== changes.current) return;
    setFailed(!data);
    if (data) {
      setItems(data.items);
      setUnread(data.unread);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onPointer = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function markRead(item: Item) {
    if (item.read) return;
    changes.current++;
    setItems((all) => all.map((i) => (i.id === item.id ? { ...i, read: true } : i)));
    setUnread((n) => Math.max(0, n - 1));
    await api.POST("/notifications/{notification_id}/read", { params: { path: { notification_id: item.id } } }).catch(() => undefined);
    changes.current++; // a poll that read the server before it applied this is stale too
  }

  async function markAll() {
    changes.current++;
    setItems((all) => all.map((i) => ({ ...i, read: true })));
    setUnread(0);
    await api.POST("/notifications/read").catch(() => undefined);
    changes.current++;
  }

  async function dismiss(item: Item) {
    changes.current++;
    panel.current?.focus(); // the dismiss button is about to disappear
    setItems((all) => all.filter((i) => i.id !== item.id));
    if (!item.read) setUnread((n) => Math.max(0, n - 1));
    await api.DELETE("/notifications/{notification_id}", { params: { path: { notification_id: item.id } } }).catch(() => undefined);
    changes.current++;
  }

  function text(item: Item) {
    const name = item.actor?.username ?? "";
    return t(item.kind as "friend_request", { name, title: item.title ?? "" });
  }

  function detail(item: Item) {
    if (item.kind === "room_invite") {
      return item.room_active === false ? t("roomEnded") : t("roomWhat", { title: item.title ?? "", episode: item.episode ?? 0 });
    }
    if (item.kind === "new_episode") return t("episode", { episode: item.episode ?? 0 });
    if (item.kind === "new_chapter") return t("chapter", { chapter: item.episode ?? 0 });
    return null;
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label={unread > 0 ? t("openUnread", { count: unread }) : t("open")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) void load();
          setOpen((v) => !v);
        }}
        className="press relative flex h-11 w-11 items-center justify-center rounded-full text-muted hover:text-fg"
      >
        <Icon name="bell" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-0 top-0 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-bold leading-4 text-on-accent"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {presence.mounted && (
        <div
          ref={panel}
          role="dialog"
          data-closing={presence.closing || undefined}
          inert={presence.closing}
          tabIndex={-1}
          aria-label={t("title")}
          className="pop-in fixed inset-x-4 top-16 z-50 flex max-h-[70dvh] origin-top flex-col rounded-ui border border-line bg-surface shadow-xl shadow-black/40 sm:absolute sm:origin-top-right sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96 focus:outline-none"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 className="font-sans text-base font-bold">{t("title")}</h2>
            {unread > 0 && (
              <button type="button" onClick={() => void markAll()} className="-my-2 min-h-11 text-xs text-accent hover:underline">
                {t("markAll")}
              </button>
            )}
          </div>
          {failed && items.length > 0 && (
            <p role="alert" className="border-b border-line px-4 py-2 text-xs text-danger">
              {t("loadFailed")}
            </p>
          )}
          <ul className="overflow-y-auto overscroll-contain">
            {items.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-muted">{failed ? t("loadFailed") : t("empty")}</li>
            )}
            {items.map((item) => {
              const href = hrefOf(item);
              const body = (
                <>
                  {item.actor ? (
                    <Avatar userId={item.actor.id} username={item.actor.username} avatar={item.actor.avatar} size={36} />
                  ) : (
                    <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-ui bg-line text-accent">
                      <Icon name="bell" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1 text-sm">
                    <span className={`block ${item.read ? "text-muted" : "font-medium"}`}>{text(item)}</span>
                    {detail(item) && <span className="block truncate text-muted">{detail(item)}</span>}
                    <span className="block text-xs text-muted">{format.relativeTime(new Date(item.created_at))}</span>
                  </span>
                </>
              );
              return (
                <li key={item.id} className="flex items-start gap-1 border-b border-line last:border-b-0 hover:bg-line/40">
                  {href ? (
                    <Link
                      href={href}
                      onClick={() => {
                        void markRead(item);
                        setOpen(false);
                      }}
                      className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3">{body}</div>
                  )}
                  <button
                    type="button"
                    onClick={() => void dismiss(item)}
                    aria-label={t("dismissItem", { text: text(item) })}
                    className="mr-1 mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-line active:bg-line"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
