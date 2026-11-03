import type { ReactNode } from "react";

import { LocaleSwitcher } from "@/components/shell/LocaleSwitcher";
import { Link } from "@/i18n/navigation";
import { Logo } from "@/components/shell/Logo";
import { APP_NAME } from "@/lib/brand";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12 short:flex-row short:gap-12 short:py-3">
      <div className="absolute right-4 top-4 short:hidden sm:right-8 sm:top-6">
        <LocaleSwitcher />
      </div>
      <div className="flex flex-col items-center gap-4">
        <Link href="/" aria-label={APP_NAME}>
          <Logo size="lg" />
        </Link>
        <div className="hidden short:block">
          <LocaleSwitcher />
        </div>
      </div>
      {children}
    </div>
  );
}
