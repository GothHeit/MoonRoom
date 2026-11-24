import Image from "next/image";

import { APP_NAME } from "@/lib/brand";

/**
 * Outlined wordmark with the crescent as its full stop (the lockup is 1039x250). In the nav, the
 * narrowest phones and the tablet-width desktop bar show the crescent alone so the rest still fits,
 * and other phones get it a little smaller so the Messages icon and the bell fit beside the switch.
 */
export function Logo({ size = "md" }: { size?: "md" | "lg" }) {
  const height = size === "lg" ? 56 : 32;
  const lockup = (
    <Image
      src="/logo-lockup.svg"
      alt={APP_NAME}
      width={Math.round((height * 1039) / 250)}
      height={height}
      unoptimized
      priority
      className={size === "md" ? "hidden h-[26px] w-auto min-[380px]:block sm:h-8 md:hidden lg:block short:block" : undefined}
    />
  );
  if (size === "lg") return lockup;
  return (
    <>
      {lockup}
      <Image src="/logo-mark.svg" alt={APP_NAME} width={height} height={height} unoptimized priority className="block min-[380px]:hidden md:block lg:hidden short:hidden" />
    </>
  );
}
