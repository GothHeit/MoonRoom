"use client";

import { useLocale, useTranslations } from "next-intl";

import { Avatar } from "@/components/ui/Avatar";
import { Link } from "@/i18n/navigation";
import { chatName, messagesHref, sameDay, type ChatOut, type MessageOut } from "@/lib/messages";

import { icons } from "./icons";
import { GroupFaces } from "./PickList";

/** "sent you Frieren · Ep 4", "You: ok", "pondofe: ep 9 was insane". */
export function usePreview() {
  const t = useTranslations("messages");
  return (chat: ChatOut, message: MessageOut | null | undefined) => {
    if (!message) return "";
    const share = message.share;
    const part = share
      ? share.episode != null
        ? t("episodeShort", { n: share.episode })
        : share.chapter != null
          ? t("chapterShort", { n: share.chapter })
          : null
      : null;
    const shared = share ? [share.hidden ? t("adultTitle") : share.title, part].filter(Boolean).join(" · ") : "";
    const text = message.body ? message.body.replace(/\s+/g, " ") : message.mine || chat.kind === "group" ? t("sent", { title: shared }) : t("sentYou", { title: shared });
    if (message.mine) return t("you", { text });
    return chat.kind === "group" ? t("from", { name: message.user.username, text }) : text;
  };
}

/** Times in the viewer's own time zone (the site formats in UTC so server and browser agree,
 * but chats only render in the browser). */
export function useLocalFormat() {
  const locale = useLocale();
  return (at: Date, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(at);
}

/** Today: the time; yesterday; this week: the weekday; before: the date. */
export function useStamp() {
  const t = useTranslations("messages");
  const local = useLocalFormat();
  return (iso: string) => {
    const at = new Date(iso);
    const now = new Date();
    if (sameDay(at, now)) return local(at, { hour: "numeric", minute: "2-digit" });
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(at, yesterday)) return t("yesterday");
    if (now.getTime() - at.getTime() < 6 * 86_400_000) return local(at, { weekday: "short" });
    return local(at, { day: "numeric", month: "short" });
  };
}

export function ChatFace({ chat, size }: { chat: ChatOut; size: number }) {
  if (chat.kind === "group") return <GroupFaces members={chat.members} size={size} />;
  const other = chat.members[0];
  if (!other) return <span aria-hidden="true" style={{ width: size, height: size }} className="shrink-0 rounded-full bg-line" />;
  return <Avatar userId={other.id} username={other.username} avatar={other.avatar} size={size} />;
}

export function ChatList({ chats, selected, names }: { chats: ChatOut[]; selected?: string; names: (n: string[]) => string }) {
  const t = useTranslations("messages");
  const preview = usePreview();
  const stamp = useStamp();

  return (
    <ul>
      {chats.map((chat) => {
        const on = chat.id === selected;
        const unread = chat.unread > 0;
        const name = chatName(chat, names);
        return (
          <li key={chat.id}>
            <Link
              href={messagesHref(chat.id)}
              aria-current={on ? "page" : undefined}
              className={`flex min-h-[4.5rem] items-center gap-3.5 px-4 py-2.5 [--ring:var(--color-bg)] hover:bg-surface md:px-6 ${on ? "bg-surface [--ring:var(--color-surface)]" : ""}`}
            >
              <ChatFace chat={chat} size={48} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={`truncate text-[15px] ${unread ? "font-bold" : "font-medium"}`}>{name}</span>
                  {chat.last && (
                    <time dateTime={chat.last.created_at} className={`ml-auto shrink-0 text-xs ${unread && !chat.muted ? "font-bold text-accent" : "text-muted"}`}>
                      {stamp(chat.last.created_at)}
                    </time>
                  )}
                </span>
                <span className={`mt-0.5 flex items-center gap-1.5 text-sm ${unread ? "text-soft" : "text-muted"}`}>
                  {unread && !chat.muted && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-accent" />}
                  {chat.muted && <span className="text-muted">{icons.muted}</span>}
                  <span className="truncate">{preview(chat, chat.last)}</span>
                  {unread && <span className="sr-only">{t("unread", { count: chat.unread })}</span>}
                  {chat.muted && <span className="sr-only">{t("muted")}</span>}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
