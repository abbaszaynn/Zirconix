import { Platform } from 'react-native';

import { supabase } from './supabase';

/**
 * Browser Web Push registration.
 *
 * Native has its own path (lib/push.ts, via expo-notifications and Expo's
 * push service) — this is the web-only equivalent, and the reason a director
 * can be notified with the zirconix.gbmines.com tab closed, or the browser
 * itself not running: the browser's own push service wakes the service
 * worker (public/sw.js) directly, outside any page's JS.
 *
 * Every failure path here returns false rather than throwing. None of it is
 * something the app can recover from by retrying (declined permission,
 * unsupported browser, missing config) and in-app notifications already work
 * regardless of whether this succeeds.
 */

export type WebPushPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export function getWebPushPermission(): WebPushPermission {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return 'unsupported';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission as WebPushPermission;
}

export async function registerWebPush(): Promise<boolean> {
  if (getWebPushPermission() === 'unsupported') return false;

  const vapidPublicKey = process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) return false; // not configured yet — see .env.example

  if (Notification.permission === 'denied') return false;

  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return false; // declined; not an error
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // TypeScript's DOM lib types applicationServerKey narrowly enough
        // (ArrayBufferView<ArrayBuffer> specifically) that the Uint8Array this
        // builds does not satisfy it without a cast, even though it is exactly
        // the shape the Push API itself expects at runtime.
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      });
    }

    const json = subscription.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;

    // save_web_push_subscription writes against current_director_id(), so a
    // client cannot register a subscription onto somebody else's record.
    const { error } = await supabase.rpc('save_web_push_subscription', {
      p_endpoint: json.endpoint,
      p_p256dh: json.keys.p256dh,
      p_auth: json.keys.auth,
      p_user_agent: navigator.userAgent,
    });

    return !error;
  } catch {
    return false;
  }
}

/** A VAPID applicationServerKey arrives base64url-encoded; the Push API wants raw bytes. */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  // Explicitly ArrayBuffer-backed: PushSubscriptionOptionsInit's
  // applicationServerKey type rejects the wider ArrayBufferLike (which also
  // covers SharedArrayBuffer) that `new Uint8Array(length)` alone infers.
  const bytes = new Uint8Array(new ArrayBuffer(rawData.length));
  for (let i = 0; i < rawData.length; i += 1) {
    bytes[i] = rawData.charCodeAt(i);
  }
  return bytes;
}
