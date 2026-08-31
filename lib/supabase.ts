import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { createClient, type SupportedStorage } from '@supabase/supabase-js';
import { Platform } from 'react-native';

if (Platform.OS === 'web' && typeof window === 'undefined') {
  if (!(globalThis as any).WebSocket) {
    (globalThis as any).WebSocket = class WebSocket {
      constructor() {}
      send() {}
      close() {}
    };
  }
}

const DummyStorage = {
  getItem: (key: string) => null,
  setItem: (key: string, value: string) => {},
  removeItem: (key: string) => {},
};

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to .env and fill it in.',
  );
}

/**
 * Session storage.
 *
 * A Supabase session is a pair of JWTs and routinely exceeds SecureStore's
 * ~2 KB per-value ceiling, so it is written in chunks with a companion key
 * holding the count. This is worth the extra code here rather than falling back
 * to AsyncStorage: on a lost or stolen phone, AsyncStorage is plain text on
 * disk, and this session can read two companies' financial records.
 *
 * Web has no SecureStore; Expo web is only used for development here.
 */
const CHUNK = 1800;

const secureChunkedStorage: SupportedStorage = {
  async getItem(key) {
    const countRaw = await SecureStore.getItemAsync(`${key}.n`);
    if (countRaw === null) return null;

    const count = Number(countRaw);
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = await SecureStore.getItemAsync(`${key}.${i}`);
      // A missing chunk means a torn write; treat the whole session as absent
      // rather than handing back a truncated JWT.
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  },

  async setItem(key, value) {
    await secureChunkedStorage.removeItem!(key);

    const count = Math.ceil(value.length / CHUNK);
    for (let i = 0; i < count; i += 1) {
      await SecureStore.setItemAsync(`${key}.${i}`, value.slice(i * CHUNK, (i + 1) * CHUNK));
    }
    // Written last, so a crash mid-write leaves no readable session.
    await SecureStore.setItemAsync(`${key}.n`, String(count));
  },

  async removeItem(key) {
    const countRaw = await SecureStore.getItemAsync(`${key}.n`);
    await SecureStore.deleteItemAsync(`${key}.n`);
    if (countRaw === null) return;
    for (let i = 0; i < Number(countRaw); i += 1) {
      await SecureStore.deleteItemAsync(`${key}.${i}`);
    }
  },
};

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: Platform.OS === 'web' ? (typeof window !== 'undefined' ? AsyncStorage : DummyStorage) : secureChunkedStorage,
    autoRefreshToken: true,
    persistSession: true,
    // A password-reset email links back to /reset-password with the recovery
    // token in the URL fragment. On web that fragment IS the session handoff —
    // without this, supabase-js never reads it, no session gets established
    // from the link, and updateUser({ password }) on the reset screen fails
    // with no session to act on. Native has no such link (a different scheme,
    // zirconix://reset-password, would need its own deep-link wiring) and
    // parsing window.location on native has no meaning, so this stays off there.
    detectSessionInUrl: Platform.OS === 'web',
  },
});

/** PKR 1,000,000. Read from the database so the app can never disagree with it. */
export async function fetchApprovalThreshold(): Promise<number> {
  const { data, error } = await supabase.rpc('approval_threshold');
  if (error) throw error;
  return Number(data);
}
