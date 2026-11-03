import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement, ReactNode } from "react";

import account from "../../messages/en/account.json";
import home from "../../messages/en/home.json";
import common from "../../messages/en/common.json";
import manga from "../../messages/en/manga.json";

import { ToastProvider } from "@/components/ui/Toast";

function Providers({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={{ ...common, ...account, ...home, ...manga }}>
      <ToastProvider>{children}</ToastProvider>
    </NextIntlClientProvider>
  );
}

/** Renders with the English common and account messages and a toast host. */
export function renderAccount(ui: ReactElement) {
  return render(ui, { wrapper: Providers });
}
