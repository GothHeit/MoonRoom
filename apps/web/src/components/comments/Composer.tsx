"use client";

import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/Button";
import { COMMENT_MAX } from "@/lib/comments";

import { icons } from "./icons";

/** The text box with the spoiler switch, the counter and the send button. Used to write and to edit. */
export function Composer({
  initialText = "",
  initialSpoiler = false,
  submitLabel,
  label,
  onSubmit,
  onCancel,
  autoFocus,
  placeholder,
  spoilerSwitch = true,
  rows = 3,
}: {
  initialText?: string;
  initialSpoiler?: boolean;
  submitLabel: string;
  label: string;
  /** Resolves to true when saved, so the box can empty itself. */
  onSubmit: (text: string, spoiler: boolean) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
  /** Replies have no spoiler mark: they sit under a comment that has one when needed. */
  spoilerSwitch?: boolean;
  rows?: number;
}) {
  const t = useTranslations("comments");
  const fieldId = useId();
  const [text, setText] = useState(initialText);
  const [spoiler, setSpoiler] = useState(initialSpoiler);
  const [busy, setBusy] = useState(false);
  const length = text.trim().length;
  const ready = length > 0 && length <= COMMENT_MAX && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    const saved = await onSubmit(text, spoiler);
    setBusy(false);
    if (saved && !onCancel) {
      setText("");
      setSpoiler(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-ui border border-line-strong bg-surface p-3 focus-within:border-accent">
      <label htmlFor={fieldId} className="sr-only">
        {label}
      </label>
      <textarea
        id={fieldId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          if (e.key === "Escape" && onCancel) onCancel();
        }}
        rows={rows}
        maxLength={COMMENT_MAX + 200}
        placeholder={placeholder ?? t("placeholder")}
        autoFocus={autoFocus}
        className={`block w-full resize-none bg-transparent text-base leading-normal text-fg outline-none! placeholder:text-muted ${rows > 1 ? "min-h-[4.5rem]" : "min-h-8"}`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2.5">
        {spoilerSwitch && (
        <button
          type="button"
          aria-pressed={spoiler}
          onClick={() => setSpoiler((v) => !v)}
          className={`press inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-bold ${
            spoiler ? "border-accent bg-line text-accent" : "border-line-strong text-fg hover:border-accent"
          }`}
        >
          {icons.eyeOff}
          {t("spoiler")}
        </button>
        )}
        <span className={`ml-auto text-xs tabular-nums ${length > COMMENT_MAX ? "text-danger" : "text-muted"}`} aria-live="polite">
          {t("counter", { count: length, max: COMMENT_MAX })}
        </span>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
        )}
        <Button type="submit" variant={ready ? "primary" : "secondary"} disabled={!ready} className="disabled:border-line disabled:text-muted disabled:opacity-100">
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
