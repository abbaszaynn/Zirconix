import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '../../lib/supabase';
import { humanError } from '../../lib/format';
import { useSession } from '../../lib/session';
import { color, space, type } from '../../lib/theme';
import { Banner, Button, Field } from '../../components/ui';

/**
 * Step-up to AAL2. Reached after sign-in when the account has a verified TOTP
 * factor, and from the approvals queue when a director needs to approve.
 */
export default function MfaChallenge() {
  const router = useRouter();
  const { refresh, signOut } = useSession();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify() {
    setError(null);
    setBusy(true);
    try {
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;

      const factor = factors?.totp?.[0];
      if (!factor) {
        router.replace('/(auth)/mfa-enroll');
        return;
      }

      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: factor.id,
      });
      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: factor.id,
        challengeId: challenge.id,
        code: code.trim(),
      });
      if (verifyError) throw verifyError;

      await refresh();
      router.replace('/(tabs)/dashboard');
    } catch (e) {
      setError(humanError(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Two-step verification</Text>
        <Text style={s.body}>
          Open your authenticator app and enter the current six-digit code for Zirconix.
        </Text>

        {error ? <Banner tone="danger" title="Code not accepted" body={error} /> : null}

        <Field
          label="Six-digit code"
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          autoComplete="one-time-code"
          placeholder="000000"
          maxLength={6}
          style={s.codeInput}
        />

        <Button label="Verify" onPress={verify} loading={busy} disabled={code.length !== 6} />
        <Button
          label="Sign out"
          variant="ghost"
          onPress={() => {
            void signOut().then(() => router.replace('/(auth)/sign-in'));
          }}
          style={{ marginTop: space.sm }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  scroll: { padding: space.xl, paddingTop: space.xxl },
  title: { ...type.title, color: color.ink, marginBottom: space.sm },
  body: { ...type.body, color: color.inkMuted, marginBottom: space.xl, lineHeight: 22 },
  codeInput: {
    fontSize: 28,
    letterSpacing: 10,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    height: 64,
  },
});
