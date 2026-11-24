"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { type ChatOut, type MessageOut, UNREAD_EVENT } from "@/lib/messages";

import { ChatList } from "./ChatList";
import { Conversation, type ChatEvent } from "./Conversation";
import { icons } from "./icons";
import { NewChat } from "./NewChat";

type Listener = (event: ChatEvent) => void;

const byRecent = (a: ChatOut, b: ChatOut) => b.last_message_at.localeCompare(a.last_message_at);

/** The Messages page: the chat list, and the open chat beside it (on phones, over it). One live
 * stream keeps both up to date. */
export function MessagesView({ selected, meId }: { selected?: string; meId: string }) {
  const t = useTranslations("messages");
  const format = useFormatter();
  const names = useCallback((n: string[]) => format.list(n, { type: "conjunction" }), [format]);
  const [chats, setChats] = useState<ChatOut[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const listeners = useRef(new Set<Listener>());
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const load = useCallback(async () => {
    const { data } = await api.GET("/chats").catch(() => ({ data: undefined }));
    setFailed(!data);
    if (data) setChats(data.items);
    window.dispatchEvent(new Event(UNREAD_EVENT));
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => void listeners.current.delete(listener);
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const emit = (event: ChatEvent) => listeners.current.forEach((l) => l(event));
    const source = new EventSource("/api/proxy/chats/events");
    let dropped = false;

    source.addEventListener("message", (e) => {
      const message = JSON.parse((e as MessageEvent).data) as MessageOut;
      setChats((all) => {
        if (!all?.some((c) => c.id === message.chat_id)) {
          void load();
          return all;
        }
        const open = selectedRef.current === message.chat_id && document.visibilityState === "visible";
        return all
          .map((c) =>
            c.id === message.chat_id
              ? { ...c, last: message, last_message_at: message.created_at, unread: message.mine || open ? c.unread : Math.min(99, c.unread + 1) }
              : c,
          )
          .sort(byRecent);
      });
      emit({ kind: "message", data: message });
      if (!message.mine) window.dispatchEvent(new Event(UNREAD_EVENT));
    });
    source.addEventListener("deleted", (e) => {
      emit({ kind: "deleted", data: JSON.parse((e as MessageEvent).data) });
      void load();
    });
    source.addEventListener("read", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { chat_id: string; user_id: string; at: string };
      setChats((all) =>
        all?.map((c) => (c.id !== data.chat_id ? c : data.user_id === meId ? { ...c, unread: 0 } : c.kind === "direct" ? { ...c, read_at: data.at } : c)) ?? all,
      );
      emit({ kind: "read", data });
    });
    for (const kind of ["chat", "left", "resync"]) {
      source.addEventListener(kind, () => {
        void load();
        if (kind === "resync") emit({ kind: "resync" });
      });
    }
    // The browser reconnects on its own; whatever happened meanwhile is fetched again.
    source.addEventListener("error", () => {
      dropped = true;
    });
    source.addEventListener("open", () => {
      if (!dropped) return;
      dropped = false;
      void load();
      emit({ kind: "resync" });
    });
    return () => {
      clearTimeout(first);
      source.close();
    };
  }, [load, meId]);

  const onRead = useCallback(() => {
    setChats((all) => all?.map((c) => (c.id === selectedRef.current ? { ...c, unread: 0 } : c)) ?? all);
    window.dispatchEvent(new Event(UNREAD_EVENT));
  }, []);

  const chat = chats?.find((c) => c.id === selected);
  // A direct chat nobody has written in yet only shows while it is open.
  const listed = chats?.filter((c) => c.last || c.kind === "group" || c.id === selected) ?? [];

  return (
    <div className="md:fixed md:inset-x-0 md:bottom-0 md:top-20 md:flex md:border-t md:border-line short:static short:block short:border-0">
      <div className={`flex flex-col pt-16 md:w-[23.75rem] md:shrink-0 md:border-r md:border-line md:pt-0 short:w-auto short:border-0 short:pt-12`}>
        <div className="flex items-center gap-3 px-4 pb-2 pt-4 md:px-6 md:pt-6">
          <h1 className="flex-1 text-4xl md:text-[2.5rem]">{t("title")}</h1>
          <button
            type="button"
            onClick={() => setCreating(true)}
            aria-label={t("newChat")}
            title={t("newChat")}
            className="press flex h-11 w-11 items-center justify-center rounded-full border border-line-strong hover:border-accent"
          >
            {icons.pen}
          </button>
        </div>
        <div className="md:min-h-0 md:flex-1 md:overflow-y-auto md:overscroll-contain">
          {failed && !chats && (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <p className="text-muted">{t("loadFailed")}</p>
              <button type="button" onClick={() => void load()} className="press min-h-11 rounded-full border border-line-strong px-5 text-sm font-bold hover:border-accent">
                {t("retry")}
              </button>
            </div>
          )}
          {!chats && !failed && (
            <div aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex min-h-[4.5rem] items-center gap-3.5 px-4 md:px-6">
                  <span className="h-12 w-12 animate-pulse rounded-full bg-surface" />
                  <span className="flex-1 space-y-2">
                    <span className="block h-4 w-28 animate-pulse rounded bg-surface" />
                    <span className="block h-3 w-44 animate-pulse rounded bg-surface" />
                  </span>
                </div>
              ))}
            </div>
          )}
          {chats && listed.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <h2 className="text-3xl">{t("emptyTitle")}</h2>
              <p className="text-muted">{t("emptyHint")}</p>
              <button type="button" onClick={() => setCreating(true)} className="press mt-2 min-h-11 rounded-full bg-accent px-5 text-sm font-bold text-on-accent">
                {t("newChat")}
              </button>
            </div>
          )}
          {listed.length > 0 && <ChatList chats={listed} selected={selected} names={names} />}
        </div>
      </div>
      <div className="hidden min-w-0 flex-1 md:flex md:flex-col short:hidden">
        {!chat && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-10 text-center">
            <h2 className="text-4xl">{t("pick")}</h2>
            <p className="text-muted">{t("pickHint")}</p>
          </div>
        )}
      </div>
      {chat && (
        <div className="contents md:absolute md:inset-y-0 md:left-[23.75rem] md:right-0 md:flex md:flex-col short:contents">
          <Conversation key={chat.id} chat={chat} subscribe={subscribe} onRead={onRead} onChanged={() => void load()} />
        </div>
      )}
      {creating && <NewChat onClose={() => setCreating(false)} onCreated={() => void load()} />}
    </div>
  );
}
