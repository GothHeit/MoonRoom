"use client";

import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";
import type { UserSummary } from "@/lib/friends";
import { GROUP_MAX, messagesHref, type ChatOut } from "@/lib/messages";
import { usePresence } from "@/lib/use-presence";

import { icons } from "./icons";
import { PickList, type PickKey } from "./PickList";
import { Sheet } from "./Sheet";

type Dialog = "rename" | "add" | "leave" | null;

/** The "…" in a chat's header: mute, and for groups rename, add people and leave. */
export function ChatMenu({ chat, name, onChanged }: { chat: ChatOut; name: string; onChanged: () => void }) {
  const t = useTranslations("messages");
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const presence = usePresence(open);
  const [dialog, setDialog] = useState<Dialog>(null);
  const group = chat.kind === "group";

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function mute() {
    setOpen(false);
    await api.PUT("/chats/{chat_id}/mute", { params: { path: { chat_id: chat.id } }, body: { muted: !chat.muted } }).catch(() => undefined);
    onChanged();
  }

  const item = "press flex min-h-11 w-full items-center px-4 text-left text-sm font-medium hover:bg-line/50";

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-label={t("options")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="press flex h-11 w-11 items-center justify-center rounded-full text-muted hover:text-fg"
      >
        {icons.dots}
      </button>
      {presence.mounted && (
        <div
          role="menu"
          data-closing={presence.closing || undefined}
          className="pop-in absolute right-0 top-full z-20 mt-1 w-56 origin-top-right overflow-hidden rounded-ui border border-line-strong bg-surface py-1"
        >
          <button type="button" role="menuitem" onClick={() => void mute()} className={item}>
            {chat.muted ? t("unmute") : t("mute")}
          </button>
          {group && (
            <>
              <button type="button" role="menuitem" onClick={() => (setOpen(false), setDialog("rename"))} className={item}>
                {t("rename")}
              </button>
              <button type="button" role="menuitem" onClick={() => (setOpen(false), setDialog("add"))} className={item}>
                {t("addPeople")}
              </button>
              <button type="button" role="menuitem" onClick={() => (setOpen(false), setDialog("leave"))} className={`${item} text-danger`}>
                {t("leave")}
              </button>
            </>
          )}
        </div>
      )}
      {dialog === "rename" && <Rename chat={chat} onClose={() => setDialog(null)} onDone={onChanged} />}
      {dialog === "add" && <AddPeople chat={chat} onClose={() => setDialog(null)} onDone={onChanged} />}
      {dialog === "leave" && (
        <Sheet
          title={t("leave")}
          onClose={() => setDialog(null)}
          footer={
            <div className="flex gap-3">
              <Button variant="secondary" className="flex-1" onClick={() => setDialog(null)}>
                {t("cancel")}
              </Button>
              <Button
                className="flex-1"
                onClick={async () => {
                  const { response } = await api
                    .DELETE("/chats/{chat_id}/members/me", { params: { path: { chat_id: chat.id } } })
                    .catch(() => ({ response: undefined }));
                  if (!response?.ok) return;
                  setDialog(null);
                  onChanged();
                  router.replace(messagesHref());
                }}
              >
                {t("leave")}
              </Button>
            </div>
          }
        >
          <p className="px-4 py-2 text-soft sm:px-5">{t("leaveConfirm", { name })}</p>
        </Sheet>
      )}
    </div>
  );
}

function Rename({ chat, onClose, onDone }: { chat: ChatOut; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("messages");
  const fieldId = useId();
  const [value, setValue] = useState(chat.name ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const { data } = await api
      .PATCH("/chats/{chat_id}", { params: { path: { chat_id: chat.id } }, body: { name: value.trim() || null } })
      .catch(() => ({ data: undefined }));
    setBusy(false);
    if (!data) return;
    onDone();
    onClose();
  }

  return (
    <Sheet
      title={t("rename")}
      onClose={onClose}
      footer={
        <Button className="w-full" disabled={busy} onClick={() => void save()}>
          {t("save")}
        </Button>
      }
    >
      <div className="px-4 py-2 sm:px-5">
        <label htmlFor={fieldId} className="sr-only">
          {t("renameLabel")}
        </label>
        <input
          id={fieldId}
          autoFocus
          value={value}
          maxLength={60}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save()}
          placeholder={t("renameLabel")}
          className="min-h-11 w-full rounded-ui border border-line-strong bg-bg px-4 py-2 text-base text-fg placeholder:text-muted focus:border-accent focus:outline-none"
        />
      </div>
    </Sheet>
  );
}

function AddPeople({ chat, onClose, onDone }: { chat: ChatOut; onClose: () => void; onDone: () => void }) {
  const t = useTranslations("messages");
  const [friends, setFriends] = useState<UserSummary[] | null>(null);
  const [selected, setSelected] = useState<Set<PickKey>>(new Set());
  const [busy, setBusy] = useState(false);
  const inside = new Set(chat.members.map((m) => m.id));
  const room = GROUP_MAX - chat.members.length - 1;

  useEffect(() => {
    void api.GET("/friends").then(
      (r) => setFriends((r.data ?? []).map((f) => f.user).sort((a, b) => a.username.localeCompare(b.username))),
      () => setFriends([]),
    );
  }, []);

  async function add() {
    setBusy(true);
    const { data } = await api
      .POST("/chats/{chat_id}/members", { params: { path: { chat_id: chat.id } }, body: { user_ids: [...selected].map((k) => k.slice(2)) } })
      .catch(() => ({ data: undefined }));
    setBusy(false);
    if (!data) return;
    onDone();
    onClose();
  }

  return (
    <Sheet
      title={t("addPeople")}
      onClose={onClose}
      footer={
        <Button className="w-full" disabled={busy || selected.size === 0} onClick={() => void add()}>
          {t("add")}
        </Button>
      }
    >
      {friends && (
        <PickList
          friends={friends}
          disabled={inside}
          selected={selected}
          onToggle={(key) =>
            setSelected((all) => {
              const next = new Set(all);
              if (next.has(key)) next.delete(key);
              else if (next.size < room) next.add(key);
              return next;
            })
          }
        />
      )}
    </Sheet>
  );
}
