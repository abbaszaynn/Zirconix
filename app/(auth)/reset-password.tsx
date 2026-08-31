import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '../../lib/supabase';
import { humanError } from '../../lib/format';
import { color, space, type } from '../../lib/theme';
import { Banner, Button, Field, Loading } from '../../components/ui';

const MIN_PASSWORD_LENGTH = 6; // matches this project's Supabase Auth minimum

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
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit =
    password.length >= MIN_PASSWORD_LENGTH && confirmPassword.length > 0 && !mismatch;

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
    if (!canSubmit) return;
    setError(null);
    setBusy(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;

      // A single-button alert renders fine on web (unlike a multi-button
      // confirm), but the split keeps this consistent with everywhere else in
      // the app that shows a result message and stops relying on
      // react-native-web behaviour that has already broken once (see the
      // delete-confirmation and forgot-password fixes).
      if (Platform.OS === 'web') {
        window.alert('Password updated successfully.');
      } else {
        Alert.alert('Password updated', 'Your password has been updated successfully.');
      }
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
                label="New password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                textContentType="newPassword"
                returnKeyType="next"
                hint={tooShort ? undefined : `At least ${MIN_PASSWORD_LENGTH} characters.`}
                error={tooShort ? `Needs at least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
              />

              <Field
                label="Confirm password"
                value={confirmPassword}
                onChangeText={setConfirmPassword}
                secureTextEntry
                autoCapitalize="none"
                textContentType="newPassword"
                onSubmitEditing={submit}
                returnKeyType="go"
                error={mismatch ? 'Does not match the password above.' : undefined}
              />

              <Button
                label="Save new password"
                onPress={submit}
                loading={busy}
                disabled={!canSubmit}
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
