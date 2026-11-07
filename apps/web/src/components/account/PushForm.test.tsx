import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider } from "@/components/ui/Toast";

import common from "../../../messages/en/common.json";
import notifications from "../../../messages/en/notifications.json";
import { PushForm } from "./PushForm";

const client = vi.hoisted(() => ({ PUT: vi.fn(), POST: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: client }));
vi.mock("@/i18n/navigation", () => ({ Link: "a" }));

const IOS_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";

function setup() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ ...common, ...notifications }}>
      <ToastProvider>
        <PushForm publicKey="BAAA" />
      </ToastProvider>
    </NextIntlClientProvider>,
  );
}

function stubPush({ permission = "default", subscribed = false }: { permission?: string; subscribed?: boolean } = {}) {
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/x",
    toJSON: () => ({ keys: { p256dh: "p", auth: "a" } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(subscribed ? subscription : null),
    subscribe: vi.fn().mockResolvedValue(subscription),
  };
  const registration = { pushManager };
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", { permission, requestPermission: vi.fn().mockResolvedValue("granted") });
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      getRegistration: vi.fn().mockResolvedValue(subscribed ? registration : undefined),
      register: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    },
  });
  return { subscription, pushManager };
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "serviceWorker");
  for (const fn of Object.values(client)) fn.mockReset();
});

describe("PushForm", () => {
  it("explains the Home Screen step on an iPhone that has not installed the site", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IOS_UA);
    setup();
    expect(await screen.findByText(/once MoonRoom is on your Home Screen/)).toBeInTheDocument();
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("registers the device when the switch is turned on", async () => {
    stubPush();
    client.PUT.mockResolvedValue({ response: { ok: true } });
    setup();
    await userEvent.click(await screen.findByRole("switch"));
    await waitFor(() =>
      expect(client.PUT).toHaveBeenCalledWith("/push/subscription", {
        body: { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "p", auth: "a" } },
      }),
    );
    expect(await screen.findByRole("switch", { checked: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send a test notification" })).toBeInTheDocument();
  });

  it("forgets the device when the switch is turned off", async () => {
    const { subscription } = stubPush({ permission: "granted", subscribed: true });
    client.POST.mockResolvedValue({ response: { ok: true } });
    setup();
    await userEvent.click(await screen.findByRole("switch", { checked: true }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/push/unsubscribe", { body: { endpoint: subscription.endpoint } }),
    );
    expect(subscription.unsubscribe).toHaveBeenCalled();
    expect(await screen.findByRole("switch", { checked: false })).toBeInTheDocument();
  });

  it("tells the user where to unblock notifications", async () => {
    stubPush({ permission: "denied" });
    setup();
    expect(await screen.findByText(/blocked for MoonRoom/)).toBeInTheDocument();
  });
});
