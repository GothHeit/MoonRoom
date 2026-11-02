import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import { AvatarForm } from "@/components/account/AvatarForm";
import { NotificationsForm } from "@/components/account/NotificationsForm";
import { MalSection } from "@/components/account/MalSection";
import { PlaybackForm } from "@/components/account/PlaybackForm";
import { PasswordForm } from "@/components/account/PasswordForm";
import { PreferencesForm } from "@/components/account/PreferencesForm";
import { SessionsPanel } from "@/components/account/SessionsPanel";
import { TwoFactorPanel } from "@/components/account/TwoFactorPanel";
import { ButtonLink } from "@/components/ui/Button";
import { serverApi, unwrap } from "@/lib/server-api";
import { titled } from "@/lib/page-title";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-ui border border-line bg-surface p-6">
      <h3 className="mb-4 text-lg font-bold">{title}</h3>
      {children}
    </section>
  );
}

/** One anchor target per group; the offset clears the fixed top bar. */
function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="flex scroll-mt-24 flex-col gap-4">
      <h2 id={`${id}-heading`} className="text-2xl">
        {title}
      </h2>
      {children}
    </section>
  );
}

const GROUPS = ["account", "preferences", "connections", "security"] as const;

export async function generateMetadata({ params }: PageProps<"/[locale]/settings">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "account" });
  return titled(t("settings.title"));
}

export default async function SettingsPage({ params, searchParams }: PageProps<"/[locale]/settings">) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("account");
  const tNotifications = await getTranslations("notifications.settings");
  const { mal } = await searchParams;

  const api = await serverApi();
  const [me, malStatus, sessions, notifications, twoFactor, playback] = await Promise.all([
    unwrap(api.GET("/me"), locale),
    unwrap(api.GET("/me/mal"), locale),
    unwrap(api.GET("/me/sessions"), locale),
    unwrap(api.GET("/notifications/settings"), locale),
    unwrap(api.GET("/me/2fa"), locale),
    unwrap(api.GET("/watch/preferences"), locale),
  ]);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 pb-8 pt-24 sm:px-8">
      <h1 className="text-4xl sm:text-5xl">{t("settings.title")}</h1>

      <nav aria-label={t("settings.groups.nav")} className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {GROUPS.map((id) => (
          <a
            key={id}
            href={`#${id}`}
            className="press inline-flex min-h-11 shrink-0 items-center rounded-full border border-line-strong px-4 text-sm font-medium text-muted hover:border-accent hover:text-fg"
          >
            {t(`settings.groups.${id}`)}
          </a>
        ))}
      </nav>

      <Group id="account" title={t("settings.groups.account")}>
        <Section title={t("settings.profile")}>
          <p className="text-sm text-muted">{t("settings.username")}</p>
          <p className="font-medium">
            {me.username}
            {me.is_admin && <span className="ml-3 rounded-full bg-accent-deep px-2.5 py-0.5 text-xs">{t("settings.admin")}</span>}
          </p>
          {me.is_admin && (
            <ButtonLink href="/invites" variant="secondary" className="mt-4">
              {t("invites.manage")}
            </ButtonLink>
          )}
        </Section>

        <Section title={t("avatar.title")}>
          <AvatarForm userId={me.id} username={me.username} avatar={me.avatar} />
        </Section>
      </Group>

      <Group id="preferences" title={t("settings.groups.preferences")}>
        <Section title={t("settings.preferences")}>
          <PreferencesForm showNsfw={me.show_nsfw} shareActivity={me.share_activity} />
        </Section>

        <Section title={t("settings.playback.title")}>
          <PlaybackForm
            audio={playback.audio_lang ?? "original"}
            subtitle={me.subtitle_lang ?? null}
            softSubs={playback.prefer_soft_subs ?? true}
            maxResolution={playback.max_resolution ?? null}
          />
        </Section>

        <Section title={tNotifications("title")}>
          <NotificationsForm muted={notifications.muted} />
        </Section>
      </Group>

      <Group id="connections" title={t("settings.groups.connections")}>
        <Section title={t("mal.title")}>
          <MalSection status={malStatus} returned={typeof mal === "string" ? mal : undefined} />
        </Section>
      </Group>

      <Group id="security" title={t("settings.groups.security")}>
        <Section title={t("password.title")}>
          <PasswordForm />
        </Section>

        <Section title={t("twoFactor.title")}>
          <TwoFactorPanel status={twoFactor} />
        </Section>

        <Section title={t("sessions.title")}>
          <SessionsPanel sessions={sessions} />
        </Section>
      </Group>
    </div>
  );
}
