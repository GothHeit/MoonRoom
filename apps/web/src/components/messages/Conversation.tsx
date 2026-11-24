"use client";

import { useFormatter, useTranslations } from "next-intl";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Link } from "@/i18n/navigation";
import { api } from "@/lib/api";
import { profileHref } from "@/lib/friends";
import { chatName, messagesHref, MESSAGES_PAGE, RUN_MS, sameDay, type ChatOut, type MessageOut, type ShareIn } from "@/lib/messages";

import { Avatar } from "@/components/ui/Avatar";

import { ChatFace, useLocalFormat } from "./ChatList";
import { ChatMenu } from "./ChatMenu";
import { icons } from "./icons";
import { MessageComposer } from "./MessageComposer";
import { ShareCard } from "./ShareCard";
import { SharePicker } from "./SharePicker";

export type ChatEvent =
  | { kind: "message"; data: MessageOut }
  | { kind: "deleted"; data: { chat_id: string; message_id: string } }
  | { kind: "read"; data: { chat_id: string; user_id: string; at: string } }
  | { kind: "resync" };

type Props = {
  chat: ChatOut;
  subscribe: (listener: (event: ChatEvent) => void) => () => void;
  /** Called once the viewer has read up to now. */
  onRead: () => void;
  onChanged: () => void;
};

/** Near enough to the bottom that a new message should scroll into view. */
const STICKY_PX = 120;

/** One chat: the header, the messages (older ones load on demand) and the box to write. */
export function Conversation({ chat, subscribe, onRead, onChanged }: Props) {
  const t = useTranslations("messages");
  const format = useFormatter();
  const local = useLocalFormat();
  const names = (n: string[]) => format.list(n, { type: "conjunction" });
  const [messages, setMessages] = useState<MessageOut[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // Set before a change that should keep the view where it is (older messages added on top).
  const keep = useRef<{ height: number; top: number } | null>(null);
  const stick = useRef(true);
  const name = chatName(chat, names);
  const group = chat.kind === "group";

  const markRead = useCallback(() => {
    if (document.visibilityState !== "visible") return;
    void api.PUT("/chats/{chat_id}/read", { params: { path: { chat_id: chat.id } } }).then(onRead, () => undefined);
  }, [chat.id, onRead]);

  const load = useCallback(async () => {
    setFailed(false);
    const { data } = await api
      .GET("/chats/{chat_id}/messages", { params: { path: { chat_id: chat.id }, query: { limit: MESSAGES_PAGE } } })
      .catch(() => ({ data: undefined }));
    if (!data) return setFailed(true);
    stick.current = true;
    setMessages(data.items);
    setNext(data.next ?? null);
  }, [chat.id]);

  // Mounted once per chat (keyed by its id), so there is no earlier chat's state to clear.
  useEffect(() => {
    const first = setTimeout(() => {
      void load();
      markRead();
    }, 0);
    return () => clearTimeout(first);
  }, [load, markRead]);

  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && chat.unread > 0 && markRead();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [chat.unread, markRead]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.kind === "resync") return void load();
        if (event.data.chat_id !== chat.id) return;
        if (event.kind === "message") {
          const el = scroller.current;
          stick.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_PX || event.data.mine;
          setMessages((all) => (all && !all.some((m) => m.id === event.data.id) ? [...all, event.data] : all));
          if (!event.data.mine) markRead();
        } else if (event.kind === "deleted") {
          setMessages((all) => all?.filter((m) => m.id !== event.data.message_id) ?? all);
        }
      }),
    [subscribe, chat.id, load, markRead],
  );

  // Before paint: stay at the bottom, or where the reader was when older messages came in.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages) return;
    if (keep.current) {
      el.scrollTop = el.scrollHeight - keep.current.height + keep.current.top;
      keep.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  async function older() {
    if (!next || loadingOlder) return;
    setLoadingOlder(true);
    const { data } = await api
      .GET("/chats/{chat_id}/messages", { params: { path: { chat_id: chat.id }, query: { before: next, limit: MESSAGES_PAGE } } })
      .catch(() => ({ data: undefined }));
    setLoadingOlder(false);
    if (!data) return;
    const el = scroller.current;
    keep.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    setMessages((all) => [...data.items.filter((m) => !all?.some((a) => a.id === m.id)), ...(all ?? [])]);
    setNext(data.next ?? null);
  }

  async function send(body: string | null, share?: ShareIn): Promise<boolean> {
    setSendError(null);
    const { data, error } = await api
      .POST("/chats/{chat_id}/messages", { params: { path: { chat_id: chat.id } }, body: { body, share: share ?? null } })
      .catch(() => ({ data: undefined, error: undefined }));
    if (!data) {
      const code = (error as { error?: { code?: string } } | undefined)?.error?.code;
      setSendError(code === "title_unavailable" ? t("titleUnavailable") : t("sendFailed"));
      return false;
    }
    stick.current = true;
    setMessages((all) => (all && !all.some((m) => m.id === data.id) ? [...all, data] : all));
    onChanged();
    return true;
  }

  async function unsend(message: MessageOut) {
    setActionsFor(null);
    const { response } = await api
      .DELETE("/chats/{chat_id}/messages/{message_id}", { params: { path: { chat_id: chat.id, message_id: message.id } } })
      .catch(() => ({ response: undefined }));
    if (!response?.ok) return setSendError(t("unsendFailed"));
    setMessages((all) => all?.filter((m) => m.id !== message.id) ?? all);
    onChanged();
  }

  // The newest message of mine the other person has read, for "Seen" (direct chats only).
  const lastMine = messages ? [...messages].reverse().find((m) => m.mine) : undefined;
  const seen = !group && lastMine && chat.read_at && chat.read_at >= lastMine.created_at;

  function dayLabel(at: Date) {
    const now = new Date();
    if (sameDay(at, now)) return t("today");
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (sameDay(at, yesterday)) return t("yesterday");
    return local(at, { weekday: "long", day: "numeric", month: "long" });
  }

  const other = !group ? chat.members[0] : undefined;

  return (
    <section
      aria-label={name}
      className="fixed inset-0 z-50 flex flex-col bg-bg pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:static md:z-auto md:min-h-0 md:flex-1 md:p-0 short:fixed short:inset-0 short:z-50"
    >
      <header className="flex min-h-[4.75rem] shrink-0 items-center gap-3 border-b border-line px-2 pt-[env(safe-area-inset-top)] md:px-6 md:pt-0 short:px-2 short:pt-0">
        <Link
          href={messagesHref()}
          aria-label={t("back")}
          className="press flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-soft hover:text-fg md:hidden short:flex"
        >
          {icons.back}
        </Link>
        {other ? (
          <Link href={profileHref(other.id)} className="flex min-w-0 flex-1 items-center gap-3">
            <ChatFace chat={chat} size={40} />
            <span className="min-w-0">
              <span className="block truncate font-bold">{name}</span>
              {chat.muted && (
                <span className="flex items-center gap-1 text-xs text-muted">
                  {icons.muted}
                  {t("muted")}
                </span>
              )}
            </span>
          </Link>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3 [--ring:var(--color-bg)]">
            <ChatFace chat={chat} size={40} />
            <span className="min-w-0">
              <span className="block truncate font-bold">{name}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted">
                {t("people", { count: chat.members.length + 1 })}
                {chat.muted && (
                  <>
                    <span aria-hidden="true">·</span>
                    {icons.muted}
                    {t("muted")}
                  </>
                )}
              </span>
            </span>
          </div>
        )}
        <ChatMenu chat={chat} name={name} onChanged={onChanged} />
      </header>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 md:px-8">
        <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end gap-1">
          {failed && (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-muted">{t("loadFailed")}</p>
              <button type="button" onClick={() => void load()} className="press min-h-11 rounded-full border border-line-strong px-5 text-sm font-bold hover:border-accent">
                {t("retry")}
              </button>
            </div>
          )}
          {!messages && !failed && (
            <div aria-hidden="true" className="flex flex-col gap-2">
              <span className="h-10 w-48 animate-pulse self-start rounded-ui bg-surface" />
              <span className="h-10 w-40 animate-pulse self-end rounded-ui bg-surface" />
              <span className="h-10 w-56 animate-pulse self-start rounded-ui bg-surface" />
            </div>
          )}
          {next && (
            <button
              type="button"
              onClick={() => void older()}
              disabled={loadingOlder}
              className="press mb-2 min-h-11 self-center rounded-full border border-line px-4 text-[13px] font-bold text-soft hover:border-line-strong disabled:opacity-50"
            >
              {t("earlier")}
            </button>
          )}
          {messages?.map((m, i) => {
            const at = new Date(m.created_at);
            const prev = messages[i - 1];
            const after = messages[i + 1];
            const newDay = !prev || !sameDay(new Date(prev.created_at), at);
            const joined = (a: MessageOut | undefined, b: MessageOut) =>
              !!a && a.user.id === b.user.id && Math.abs(new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) < RUN_MS && sameDay(new Date(a.created_at), new Date(b.created_at));
            const first = newDay || !joined(prev, m);
            const last = !after || !joined(m, after);
            const showFace = group && !m.mine;
            const open = actionsFor === m.id;
            const bubble = m.mine ? "border-accent-deep bg-accent-deep text-fg" : "border-line bg-surface";
            return (
              <Fragment key={m.id}>
                {newDay && <p className="kicker mb-2 mt-4 self-center first:mt-0">{dayLabel(at)}</p>}
                <div className={`flex items-end gap-2.5 ${m.mine ? "justify-end" : ""} ${first && !newDay ? "mt-2" : ""}`}>
                  {showFace && (
                    <span className="w-7 shrink-0">
                      {last && <Avatar userId={m.user.id} username={m.user.username} avatar={m.user.avatar} size={28} />}
                    </span>
                  )}
                  <div className={`flex min-w-0 max-w-[82%] flex-col gap-1 md:max-w-[min(32.5rem,78%)] ${m.mine ? "items-end" : "items-start"}`}>
                    {showFace && first && <span className="px-1 text-xs font-bold text-soft">{m.user.username}</span>}
                    {m.share && <ShareCard share={m.share} />}
                    {m.body &&
                      (m.mine ? (
                        <button
                          type="button"
                          onClick={() => setActionsFor(open ? null : m.id)}
                          aria-expanded={open}
                          className={`max-w-full whitespace-pre-wrap break-words rounded-ui border px-3.5 py-2.5 text-left text-[15px] leading-snug ${bubble}`}
                        >
                          {m.body}
                        </button>
                      ) : (
                        <p className={`max-w-full whitespace-pre-wrap break-words rounded-ui border px-3.5 py-2.5 text-[15px] leading-snug ${bubble}`}>{m.body}</p>
                      ))}
                    {m.mine && !m.body && (
                      <button type="button" onClick={() => setActionsFor(open ? null : m.id)} aria-expanded={open} className="px-1 text-xs text-muted hover:text-fg">
                        {icons.dots}
                        <span className="sr-only">{t("unsend")}</span>
                      </button>
                    )}
                    {open && (
                      <button type="button" onClick={() => void unsend(m)} className="press min-h-11 rounded-full border border-line-strong px-4 text-[13px] font-bold text-danger hover:border-danger">
                        {t("unsend")}
                      </button>
                    )}
                    {(last || open) && (
                      <span className="px-1 text-xs text-muted">
                        {local(at, { hour: "numeric", minute: "2-digit" })}
                        {seen && m.id === lastMine?.id && ` · ${t("seen")}`}
                      </span>
                    )}
                  </div>
                </div>
              </Fragment>
            );
          })}
        </div>
      </div>

      {sendError && (
        <p role="alert" className="shrink-0 px-4 pb-1 text-center text-sm text-danger">
          {sendError}
        </p>
      )}
      {chat.can_send ? (
        <MessageComposer
          key={chat.id}
          placeholder={group ? t("placeholderGroup") : t("placeholder", { name })}
          onSend={(text) => send(text)}
          onShare={() => setPicking(true)}
        />
      ) : (
        <p className="shrink-0 border-t border-line px-6 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-4 text-center text-sm text-muted">{t("readOnly")}</p>
      )}
      {picking && <SharePicker onClose={() => setPicking(false)} onPick={(share) => send(null, share)} />}
    </section>
  );
}
