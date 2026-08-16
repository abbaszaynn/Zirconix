import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '../../lib/supabase';
import { humanError } from '../../lib/format';
import { color, space, type } from '../../lib/theme';
import { Banner, Button, Field } from '../../components/ui';

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });
      if (signInError) throw signInError;

      // If this account has a verified TOTP factor, the session is still aal1
      // until the code is entered. Send them straight to the challenge.
      const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aal?.nextLevel === 'aal2' && aal.currentLevel !== 'aal2') {
        router.replace('/(auth)/mfa-challenge');
        return;
      }

      router.replace('/(tabs)/dashboard');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (!email.trim()) {
      setError('Please enter your email address first.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const redirectUrl =
        Platform.OS === 'web'
          ? `${window.location.origin}/reset-password`
          : 'zirconix://reset-password';

      const { error: resetError } = await supabase.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        {
          redirectTo: redirectUrl,
        },
      );
      if (resetError) throw resetError;
      Alert.alert('Reset link sent', 'Check your email for a link to reset your password.');
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
            <Text style={s.tagline}>
              Consortium expenditure &amp; accountability{'\n'}
              Durr Mines &amp; Minerals · Zircon Mines
            </Text>
          </View>

          {error ? <Banner tone="danger" title="Could not sign in" body={error} /> : null}

          <Field
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="you@company.com"
          />

          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            textContentType="password"
            onSubmitEditing={submit}
            returnKeyType="go"
          />

          <Button
            label="Sign in"
            onPress={submit}
            loading={busy}
            disabled={!email.trim() || !password}
          />

          <Button
            label="Forgot password?"
            variant="ghost"
            onPress={resetPassword}
            disabled={busy}
            style={{ marginTop: 8 }}
          />

          <Text style={s.footnote}>
            Access is by invitation. Your email must already be on the consortium's director list —
            signing up with any other address will not grant access to either company's records.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  flex: { flex: 1 },
  scroll: { padding: space.xl, paddingTop: space.xxl * 2, flexGrow: 1 },
  brand: { marginBottom: space.xxl },
  wordmark: {
    ...type.display,
    color: color.ink,
    letterSpacing: 4,
    fontSize: 26,
  },
  tagline: {
    ...type.body,
    color: color.inkMuted,
    marginTop: space.md,
    lineHeight: 22,
  },
  footnote: {
    ...type.caption,
    color: color.inkMuted,
    marginTop: space.xl,
    lineHeight: 18,
  },
});
