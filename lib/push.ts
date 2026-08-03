import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';

import { supabase } from './supabase';

/**
 * Expo push registration.
 *
 * A push token is issued by the OS, not by us, and only on a real device — a
 * simulator or the web build will never produce one. Everything here therefore
 * fails soft: if no token can be obtained the director simply keeps getting
 * in-app notifications, which are written regardless of whether push works.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPush(): Promise<string | null> {
  if (Platform.OS === 'web' || !Device.isDevice) {
    return null; // no push on simulators or the browser
  }

  // Android needs a channel before anything will surface with sound.
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Transfers and approvals',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;

  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') {
    return null; // the director declined; not an error
  }

  const projectId =
    (Notifications as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;

  let token: string;
  try {
    const result = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    token = result.data;
  } catch {
    // Most often a project without an EAS id, which cannot issue tokens.
    return null;
  }

  // set_push_token writes against current_director_id(), so a client cannot
  // register a token onto somebody else's record.
  const { error } = await supabase.rpc('set_push_token', { p_token: token });
  if (error) return null;

  return token;
}
