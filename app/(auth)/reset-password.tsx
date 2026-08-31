import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '../../lib/supabase';
import { humanError } from '../../lib/format';
import { color, space, type } from '../../lib/theme';
import { Banner, Button, Field, Loading } from '../../components/ui';

/**
 * Reached from the "Forgot password?" email link.
 *
 * The link carries a recovery token in the URL, which supabase-js (web only —
 * see detectSessionInUrl in lib/supabase.ts) turns into a real, temporary
 * session before this component ever mounts. That session is what
 * updateUser({ password }) below acts on.
 *
 * Session detection is asynchronous, so this cannot assume a session exists
 * on the first render. It waits for either onAuthStateChange to report one
 * (fired with event 'PASSWORD_RECOVERY' when the link is valid) or an
 * already-resolved getSession() to come back, and treats a confirmed absence
 * of both as an expired or already-used link — one clear message, rather than
 * a confusing failure the moment the director tries to submit.
 */
export default function ResetPassword() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [linkValid, setLinkValid] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let settled = false;

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (settled) return;
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) {
        settled = true;
        setLinkValid(true);
        setChecking(false);
      }
    });

    // Covers the case where the URL was already processed by the time this
    // component mounted — onAuthStateChange only fires on a transition, not
    // for a session that resolved a moment earlier.
    supabase.auth.getSession().then(({ data }) => {
      if (settled) return;
      if (data.session) {
        settled = true;
        setLinkValid(true);
      }
      setChecking(false);
    });

    // A genuinely broken or expired link never produces a session or an
    // auth event at all — nothing above would ever fire. Stop waiting after a
    // few seconds rather than showing a spinner forever.
    const timeout = setTimeout(() => {
      if (!settled) setChecking(false);
    }, 4000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, []);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      router.replace('/(tabs)/dashboard');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={s.flex}
      >
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
          <View style={s.brand}>
            <Text style={s.wordmark}>ZIRCONIX</Text>
            <Text style={s.tagline}>Set a new password</Text>
          </View>

          {checking ? (
            <Loading />
          ) : !linkValid ? (
            <>
              <Banner
                tone="danger"
                title="This link no longer works"
                body="Password reset links expire after a while, or can only be used once. Go back to sign-in and request a new one."
              />
              <Button
                label="Back to sign-in"
                variant="secondary"
                onPress={() => router.replace('/(auth)/sign-in')}
                style={{ marginTop: space.lg }}
              />
            </>
          ) : (
            <>
              {error ? <Banner tone="danger" title="Could not update password" body={error} /> : null}

              <Field
                label="New Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                textContentType="newPassword"
                onSubmitEditing={submit}
                returnKeyType="go"
              />

              <Button
                label="Save new password"
                onPress={submit}
                loading={busy}
                disabled={!password}
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  flex: { flex: 1 },
  scroll: { padding: space.xl, flexGrow: 1, justifyContent: 'center', gap: space.lg },
  brand: { marginBottom: space.xxl },
  wordmark: {
    ...type.display,
    color: color.ink,
    letterSpacing: 4,
    fontSize: 26,
    marginBottom: space.sm,
  },
  tagline: {
    ...type.body,
    color: color.inkMuted,
    lineHeight: 22,
  },
});
