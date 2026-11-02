import { getTranslations } from "next-intl/server";

import { artImage } from "@/components/ui/artImage";
import { ButtonLink } from "@/components/ui/Button";
import { HERO_SIZES } from "@/components/ui/HeroSplit";
import { Skeleton } from "@/components/ui/Skeleton";

import { titleArt } from "./titleArt";
import { watchPlan } from "./watchPlan";

// The three parts of the title header that depend on the sources. They share one cached lookup
// (watchPlan), so rendering them separately costs a single round trip.

export function WatchBadgeSkeleton() {
  return <div aria-hidden="true" className="h-6 w-24 self-start animate-pulse rounded-ui bg-surface" />;
}

// As wide as the real button ("Continue episode 12") so "Add to list" stays on the same line.
export function WatchPlaySkeleton() {
  return <Skeleton className="h-11 w-48 rounded-full" />;
}

/** The show's wide picture over the poster. Nothing when it isn't known, so the poster stays. */
export async function WideArt({ id, locale }: { id: number; locale: string }) {
  const art = await titleArt(id, locale);
  if (!art.backdrop) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- remote catalog art
    <img
      {...artImage(art.backdrop, HERO_SIZES)}
      alt=""
      fetchPriority="high"
      decoding="async"
      className="art-fade-in absolute inset-0 h-full w-full object-cover md:rounded-bl-ui"
    />
  );
}

export async function WatchBadge({ id }: { id: number }) {
  const [plan, t] = await Promise.all([watchPlan(id), getTranslations("titlePage")]);
  return (
    <p
      className={`inline-block self-start rounded-full border px-3 py-0.5 text-xs font-bold ${plan ? "border-accent text-accent" : "border-line-strong text-muted"}`}
    >
      {plan ? t("watchHere") : t("trackingOnly")}
    </p>
  );
}

export async function WatchPlay({ id }: { id: number }) {
  const [plan, t] = await Promise.all([watchPlan(id), getTranslations("titlePage")]);
  if (!plan) return null;
  return (
    <ButtonLink href={plan.href}>
      <span aria-hidden="true">▶</span>
      {plan.next.resume
        ? t("continue", { episode: plan.next.episode })
        : plan.next.rewatch
          ? t("rewatch")
          : t("play", { episode: plan.next.episode })}
    </ButtonLink>
  );
}

export async function WatchHint({ id }: { id: number }) {
  const [plan, t] = await Promise.all([watchPlan(id), getTranslations("titlePage")]);
  return plan ? null : <p className="mt-3 text-sm text-muted">{t("trackingOnlyHint")}</p>;
}
