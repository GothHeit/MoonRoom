"use client";

import { errorCode } from "@app/api-client";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { useRouter } from "@/i18n/navigation";
import { api } from "@/lib/api";

import { TvButton } from "./TvButton";
import { TvGroup } from "./TvGroup";
import { useTvFocus } from "./useTvFocus";

type Step = "idle" | "set" | "remove";

function TvField({
  label,
  hint,
  value,
  onChange,
  focusKey,
  digits,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  focusKey: string;
  digits?: boolean;
}) {
  const { ref, focused } = useTvFocus<HTMLInputElement>({
    focusKey,
    onArrow: (d) => d === "up" || d === "down",
  });
  return (
    <label className="block">
      <span className="text-[1.5rem] text-muted">{label}</span>
      {hint && <span className="ml-4 text-[1.25rem] text-muted">{hint}</span>}
      <input
        ref={ref}
        type="password"
        inputMode={digits ? "numeric" : "text"}
        maxLength={digits ? 6 : 128}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) =>
          onChange(digits ? e.target.value.replace(/\D/g, "") : e.target.value)
        }
        className={`mt-2 h-[5rem] w-full max-w-[40rem] rounded-full border-2 bg-surface px-10 text-[2rem] text-fg outline-[3px] outline-offset-4 outline-solid outline-transparent transition-transform duration-[160ms] ease-out ${
          focused
            ? "scale-[1.02] border-accent outline-accent"
            : "border-line-strong"
        }`}
      />
    </label>
  );
}

/**
 * Add, change or remove the PIN from the TV. With a PIN the TV asks for the current one; with none
 * it asks for the account password, so whoever holds the remote cannot lock the owner out.
 * The API counts a wrong current PIN against the same limit as the lock screen.
 */
export function TvPinEditor({
  pinEnabled,
  busy,
  onDone,
}: {
  pinEnabled: boolean;
  busy: boolean;
  onDone: (message: "saved" | "removed") => void;
}) {
  const t = useTranslations("tv.settings");
  const router = useRouter();
  const [step, setStep] = useState<Step>("idle");
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [next, setNext] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  function reset() {
    setStep("idle");
    setCurrent("");
    setPassword("");
    setNext("");
    setProblem(null);
  }

  async function submit() {
    const removing = step === "remove";
    if (!removing && !/^\d{4,6}$/.test(next))
      return setProblem(t("pinInvalid"));
    setProblem(null);
    setWorking(true);
    try {
      const { response, error } = removing
        ? await api.POST("/auth/pin/tv/remove", {
            body: { current_pin: current },
          })
        : await api.PUT("/auth/pin/tv", {
            body: pinEnabled
              ? { pin: next, current_pin: current }
              : { pin: next, password },
          });
      if (!response.ok) {
        const code = errorCode(error);
        setProblem(
          code === "wrong_pin"
            ? t("pinWrong")
            : code === "wrong_password"
              ? t("pinWrongPassword")
              : code === "rate_limited"
                ? t("pinTooMany")
                : t("pinFailed"),
        );
        return;
      }
      reset();
      onDone(removing ? "removed" : "saved");
      // The settings page learns from the server whether a PIN exists now.
      router.refresh();
    } catch {
      setProblem(t("pinFailed"));
    } finally {
      setWorking(false);
    }
  }

  if (step === "idle") {
    return (
      <>
        <TvButton
          focusKey="tv-pin-edit"
          disabled={busy}
          onPress={() => setStep("set")}
        >
          {pinEnabled ? t("pinChange") : t("pinAdd")}
        </TvButton>
        {pinEnabled && (
          <TvButton
            focusKey="tv-pin-remove"
            disabled={busy}
            onPress={() => setStep("remove")}
          >
            {t("pinRemove")}
          </TvButton>
        )}
      </>
    );
  }

  const removing = step === "remove";
  const ready = removing
    ? current.length >= 4
    : /^\d{4,6}$/.test(next) &&
      (pinEnabled ? current.length >= 4 : password.length > 0);
  return (
    <TvGroup className="flex flex-col gap-6" preferred="tv-pin-field-first">
      {pinEnabled ? (
        <TvField
          focusKey="tv-pin-field-first"
          label={t("pinCurrent")}
          value={current}
          onChange={setCurrent}
          digits
        />
      ) : (
        !removing && (
          <TvField
            focusKey="tv-pin-field-first"
            label={t("pinPassword")}
            hint={t("pinPasswordHint")}
            value={password}
            onChange={setPassword}
          />
        )
      )}
      {!removing && (
        <TvField
          focusKey="tv-pin-field-new"
          label={t("pinNew")}
          value={next}
          onChange={setNext}
          digits
        />
      )}
      {problem && (
        <p role="alert" className="text-[1.5rem] text-danger">
          {problem}
        </p>
      )}
      <div className="flex gap-4">
        <TvButton
          focusKey="tv-pin-save"
          variant="primary"
          disabled={working || !ready}
          onPress={() => void submit()}
        >
          {removing ? t("pinConfirmRemove") : t("pinSave")}
        </TvButton>
        <TvButton focusKey="tv-pin-cancel" disabled={working} onPress={reset}>
          {t("pinCancel")}
        </TvButton>
      </div>
    </TvGroup>
  );
}
