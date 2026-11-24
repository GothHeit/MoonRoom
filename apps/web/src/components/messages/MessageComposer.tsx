"use client";

import { useTranslations } from "next-intl";
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { MESSAGE_MAX } from "@/lib/messages";

import { icons } from "./icons";

/** A typing device without a hardware keyboard: there Enter adds a line and the button sends. */
function touchFirst() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/** The box at the bottom of a chat: share a title, write (it grows up to a few lines), send. */
export function MessageComposer({
  placeholder,
  onSend,
  onShare,
}: {
  placeholder: string;
  /** Resolves to true when sent, so the box can empty itself. */
  onSend: (text: string) => Promise<boolean>;
  onShare: () => void;
}) {
  const t = useTranslations("messages");
  const fieldId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const length = text.trim().length;
  const tooLong = length > MESSAGE_MAX;
  const ready = length > 0 && !tooLong && !busy;

  // Grow with the text, up to about six lines.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!ready) return;
    setBusy(true);
    const sent = await onSend(text);
    setBusy(false);
    if (sent) setText("");
    field.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touchFirst()) {
      e.preventDefault();
      void submit();
    }
  }

  const round = "press flex h-11 w-11 shrink-0 items-center justify-center rounded-full";

  return (
    <form
      onSubmit={submit}
      className="flex shrink-0 items-end gap-2 border-t border-line px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 md:gap-2.5 md:px-6 md:pb-4 short:pb-2 short:pt-2"
    >
      <button type="button" onClick={onShare} aria-label={t("shareTitle")} title={t("shareTitle")} className={`${round} border border-line-strong text-soft hover:border-accent hover:text-fg`}>
        {icons.share}
      </button>
      <label htmlFor={fieldId} className="sr-only">
        {t("label")}
      </label>
      <textarea
        ref={field}
        id={fieldId}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-invalid={tooLong || undefined}
        enterKeyHint="send"
        className={`min-h-11 min-w-0 flex-1 resize-none rounded-[1.375rem] border bg-surface px-[1.125rem] py-[0.6rem] text-base leading-snug text-fg placeholder:text-muted focus:outline-none ${tooLong ? "border-danger" : "border-line-strong focus:border-accent"}`}
      />
      <button type="submit" disabled={!ready} aria-label={t("send")} className={`${round} bg-accent text-on-accent disabled:opacity-50`}>
        {icons.send}
      </button>
      {tooLong && (
        <p role="alert" className="sr-only">
          {t("tooLong", { max: MESSAGE_MAX })}
        </p>
      )}
    </form>
  );
}
