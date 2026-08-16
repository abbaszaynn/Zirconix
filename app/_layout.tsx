import { useEffect } from 'react';
import { Pressable, Text } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SessionProvider, useSession } from '../lib/session';
import { Loading } from '../components/ui';
import { color } from '../lib/theme';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Directors work at mine sites with patchy signal. Keep data on screen and
      // retry rather than flashing an error the moment a request fails.
      retry: 2,
      staleTime: 30 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});

function Gate() {
  const { loading, session, director } = useSession();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === '(auth)' || segments[0] === 'sign-in' || segments[0] === 'mfa-challenge' || segments[0] === 'mfa-enroll';
    const isResetPassword = segments[1] === 'reset-password' || segments[0] === 'reset-password';

    if (!session && !inAuthGroup) {
      router.replace('/(auth)/sign-in');
    } else if (session && inAuthGroup && !isResetPassword) {
      router.replace('/(tabs)/dashboard');
    }
  }, [loading, !!session, director, segments]);

  if (loading) return <Loading />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: color.surface },
        headerTitleStyle: { color: color.ink, fontWeight: '700' },
        headerTintColor: color.accent,
        contentStyle: { backgroundColor: color.canvas },
        headerLeft: () => (
          <Pressable
            onPress={() => {
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace('/');
              }
            }}
            style={{ marginRight: 16 }}
          >
            <Text style={{ color: color.accent, fontSize: 16, fontWeight: '500' }}>Back</Text>
          </Pressable>
        ),
      }}
    >
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="profile" options={{ title: 'Profile', presentation: 'modal' }} />
      <Stack.Screen
        name="disbursement/new"
        options={{ title: 'Record a disbursement', presentation: 'modal' }}
      />
      <Stack.Screen
        name="expenditure/new"
        options={{ title: 'Log an expenditure', presentation: 'modal' }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          <StatusBar style="dark" />
          <Gate />
        </SessionProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
