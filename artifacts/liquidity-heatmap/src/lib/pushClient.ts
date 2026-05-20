import { apiFetch, readJson } from "./api";

interface VapidResponse {
  enabled?: boolean;
  publicKey?: string | null;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

function serializeSubscription(subscription: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const json = subscription.toJSON();
  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    keys: {
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
    },
  };
}

export async function ensureBrowserPushSubscription(): Promise<{ ok: boolean; message: string }> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return { ok: false, message: "Browser push is not supported in this browser." };
  }

  const keyRes = await apiFetch("/api/push/vapid-public-key");
  if (!keyRes.ok) return { ok: false, message: "Could not load push configuration." };
  const config = await readJson<VapidResponse>(keyRes, {});
  if (!config.enabled || !config.publicKey) {
    return { ok: false, message: "Server push is disabled. Add VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Replit Secrets." };
  }

  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") return { ok: false, message: "Notification permission was not granted." };

  const registration = await navigator.serviceWorker.register("/push-sw.js");
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
  }

  const payload = serializeSubscription(subscription);
  if (!payload.endpoint || !payload.keys.p256dh || !payload.keys.auth) {
    return { ok: false, message: "Browser returned an incomplete push subscription." };
  }

  const saveRes = await apiFetch("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!saveRes.ok) return { ok: false, message: "Could not save push subscription." };
  return { ok: true, message: "Push notifications are enabled for this browser." };
}
