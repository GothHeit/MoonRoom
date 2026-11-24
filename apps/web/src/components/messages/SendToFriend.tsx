"use client";

import { useTranslations } from "next-intl";
import { Suspense, use, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/Button";
import { placeholderFor } from "@/components/ui/PosterCard";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import type { UserSummary } from "@/lib/friends";
import { MESSAGE_MAX, SHARE_TARGETS_MAX, UNREAD_EVENT, type ChatOut, type ShareIn } from "@/lib/messages";

import { icons } from "./icons";
import { PickList, type PickKey } from "./PickList";
import { Sheet } from "./Sheet";

type Props = {
  kind: "anime" | "manga";
  id: number;
  title: string;
  poster?: string | null;
  /** The episode or chapter the viewer is on, offered beside the whole title. A promise while
   * the page still works it out: the button works at once and the choice appears when known. */
  part?: Promise<number | string | null> | number | string | null;
};

/** The round send button on a title page and the sheet it opens: pick friends and groups, choose
 * the whole title or the current episode (or chapter), add a note, send. */
export function SendToFriend({ kind, id, title, poster, part }: Props) {
  const t = useTranslations("messages");
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("sendTo")}
        aria-haspopup="dialog"
        title={t("sendTo")}
        className="press flex h-11 w-11 items-center justify-center rounded-full border border-line-strong text-fg hover:border-accent"
      >
        {icons.send}
      </button>
      {open && <SendSheet kind={kind} id={id} title={title} poster={poster} part={part} onClose={() => setOpen(false)} />}
    </div>
  );
}

function SendSheet({ kind, id, title, poster, part, onClose }: Props & { onClose: () => void }) {
  const t = useTranslations("messages");
  const toast = useToast();
  const noteId = useId();
  const [friends, setFriends] = useState<UserSummary[] | null>(null);
  const [groups, setGroups] = useState<ChatOut[]>([]);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Set<PickKey>>(new Set());
  const [whole, setWhole] = useState(true);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([api.GET("/friends"), api.GET("/chats")])
      .then(([f, c]) => {
        if (!live) return;
        if (!f.data) return setFailed(true);
        setFriends(f.data.map((x) => x.user).sort((a, b) => a.username.localeCompare(b.username)));
        setGroups((c.data?.items ?? []).filter((x) => x.kind === "group"));
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);

  function toggle(key: PickKey) {
    setSelected((all) => {
      const next = new Set(all);
      if (next.has(key)) next.delete(key);
      else if (next.size < SHARE_TARGETS_MAX) next.add(key);
      return next;
    });
  }

  // The episode or chapter picked instead of the whole title, once the page knows it.
  const [chosen, setChosen] = useState<number | string | null>(null);

  async function send() {
    if (selected.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    const share: ShareIn =
      kind === "anime"
        ? { kind, id, episode: !whole && chosen != null ? Number(chosen) : null }
        : { kind, id, chapter: !whole && chosen != null ? String(chosen) : null };
    const keys = [...selected];
    const { data, error: failure } = await api
      .POST("/chats/share", {
        body: {
          share,
          body: note.trim() || null,
          user_ids: keys.filter((k) => k.startsWith("u:")).map((k) => k.slice(2)),
          chat_ids: keys.filter((k) => k.startsWith("c:")).map((k) => k.slice(2)),
        },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    setBusy(false);
    if (!data) {
      const code = (failure as { error?: { code?: string } } | undefined)?.error?.code;
      setError(code === "title_unavailable" ? t("titleUnavailable") : t("sendFailed"));
      return;
    }
    window.dispatchEvent(new Event(UNREAD_EVENT));
    toast(t("sentToast"), "success");
    onClose();
  }

  const empty = friends !== null && friends.length === 0 && groups.length === 0;

  return (
    <Sheet
      title={t("sendTo")}
      onClose={onClose}
      footer={
        !empty && (
          <>
            {error && (
              <p role="alert" className="mb-2 text-sm text-danger">
                {error}
              </p>
            )}
            <Button onClick={() => void send()} disabled={selected.size === 0 || busy} className="w-full">
              {selected.size > 0 ? t("sendCount", { count: selected.size }) : t("sendToShort")}
            </Button>
          </>
        )
      }
    >
      <div className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-5">
        <span className={`relative block aspect-[2/3] w-11 shrink-0 overflow-hidden rounded-ui ${placeholderFor(id)}`}>
          {poster && (
            // eslint-disable-next-line @next/next/no-img-element -- remote catalog art
            <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-xl leading-tight">{title}</p>
          <Suspense fallback={null}>
            <PartChoice kind={kind} title={title} part={part} whole={whole} onChoose={(value, n) => (setWhole(value), setChosen(n))} />
          </Suspense>
        </div>
      </div>
      {failed && <p className="px-5 py-6 text-center text-sm text-muted">{t("loadFailed")}</p>}
      {friends === null && !failed && (
        <div aria-hidden="true" className="space-y-3 px-5 py-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="h-9 w-9 animate-pulse rounded-full bg-line" />
              <span className="h-4 w-32 animate-pulse rounded bg-line" />
            </div>
          ))}
        </div>
      )}
      {empty && <p className="px-5 py-6 text-center text-sm text-muted">{t("noFriends")}</p>}
      {friends && !empty && (
        <>
          <PickList friends={friends} groups={groups} selected={selected} onToggle={toggle} />
          <div className="px-4 pb-1 pt-3 sm:px-5">
            <label htmlFor={noteId} className="sr-only">
              {t("note")}
            </label>
            <input
              id={noteId}
              value={note}
              maxLength={MESSAGE_MAX}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("note")}
              className="min-h-11 w-full rounded-ui border border-line-strong bg-bg px-4 py-2 text-base text-fg placeholder:text-muted focus:border-accent focus:outline-none"
            />
          </div>
        </>
      )}
    </Sheet>
  );
}

function PartChoice({
  kind,
  title,
  part,
  whole,
  onChoose,
}: {
  kind: "anime" | "manga";
  title: string;
  part: Props["part"];
  whole: boolean;
  onChoose: (whole: boolean, part: number | string | null) => void;
}) {
  const t = useTranslations("messages");
  const n = part instanceof Promise ? use(part) : part;
  if (n == null || n === "") return null;
  const options: [boolean, string][] = [
    [true, t("whole")],
    [false, kind === "anime" ? t("episode", { n }) : t("chapter", { n })],
  ];
  return (
    <div role="radiogroup" aria-label={title} className="mt-1.5 inline-flex rounded-full border border-line-strong p-0.5">
      {options.map(([value, label]) => (
        <button
          key={String(value)}
          type="button"
          role="radio"
          aria-checked={whole === value}
          onClick={() => onChoose(value, value ? null : n)}
          className={`press min-h-11 rounded-full px-3.5 text-[13px] font-bold ${whole === value ? "bg-line text-fg" : "text-soft"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
