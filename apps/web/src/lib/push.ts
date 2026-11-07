import { api } from "@/lib/api";

export type PushState =
  /** Not known yet (server render). */
  | "checking"
  /** This browser can't receive pushes at all. */
  | "unsupported"
  /** iPhone or iPad Safari: pushes only work once the site is on the Home Screen. */
  | "install"
  /** The user said no in the browser; only its settings can undo that. */
  | "denied"
  | "off"
  | "on";

const SW_URL = "/sw.js";

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

function isIos() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

function canPush() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration(SW_URL);
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** What the settings switch should show on this device right now. */
export async function pushState(): Promise<PushState> {
  if (!canPush()) return isIos() && !isStandalone() ? "install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted" && (await currentSubscription())) return "on";
  return "off";
}

function keyBytes(base64url: string) {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function body(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return { endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" } };
}

/** Asks the browser for permission and registers this device. Call it from a click: iOS refuses otherwise.
 * Returns the new state. */
export async function enablePush(publicKey: string): Promise<PushState> {
  if (!canPush()) return pushState();
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  await navigator.serviceWorker.register(SW_URL);
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  const { response } = await api.PUT("/push/subscription", { body: body(subscription) });
  if (!response.ok) {
    await subscription.unsubscribe().catch(() => false);
    throw new Error("subscribe failed");
  }
  return "on";
}

/** Stops phone notifications on this device. */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await api.POST("/push/unsubscribe", { body: { endpoint: subscription.endpoint } }).catch(() => undefined);
  await subscription.unsubscribe().catch(() => false);
}

const SYNCED_KEY = "moonroom.push.synced";

/** Tells the server this device belongs to the signed-in user, once per browser session and account, so a phone
 * that changed accounts never keeps receiving the earlier account's messages. */
export async function syncPush(userId: string): Promise<void> {
  try {
    if (!canPush() || Notification.permission !== "granted" || sessionStorage.getItem(SYNCED_KEY) === userId) return;
    const subscription = await currentSubscription();
    if (!subscription) return;
    const { response } = await api.PUT("/push/subscription", { body: body(subscription) });
    // A 404 means the server has phone notifications switched off: nothing to keep in step.
    if (response.ok || response.status === 404) sessionStorage.setItem(SYNCED_KEY, userId);
  } catch {
    // Private mode or offline: it is tried again on the next visit.
  }
}

/** Run before signing out: the next person on this phone must not get this account's messages. */
export async function forgetThisDevice(): Promise<void> {
  try {
    if (!canPush()) return;
    await disablePush();
    sessionStorage.removeItem(SYNCED_KEY);
  } catch {
    // Signing out matters more.
  }
}

export async function sendTestPush(): Promise<boolean> {
  const { response } = await api.POST("/push/test").catch(() => ({ response: null }));
  return !!response?.ok;
}
