import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '../../lib/supabase';
import { humanError } from '../../lib/format';
import { useSession } from '../../lib/session';
import { color, radius, space, type } from '../../lib/theme';
import { Banner, Button, Card, Field, Loading } from '../../components/ui';

/**
 * TOTP enrollment.
 *
 * The secret is shown as text rather than a QR code on purpose: every
 * authenticator app accepts manual key entry, and rendering the SVG QR that
 * Supabase returns would pull in react-native-svg for one screen. A director
 * setting this up once, with the phone in hand, can type 32 characters.
 */
export default function MfaEnroll() {
  const router = useRouter();
  const { refresh } = useSession();

  const [factorId, setFactorId] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        // An abandoned enrollment leaves an unverified factor behind, and
        // Supabase refuses a second one with the same friendly name. Clear it.
        const { data: existing } = await supabase.auth.mfa.listFactors();
        const stale = (existing?.all ?? []).filter(
          (f) => f.factor_type === 'totp' && f.status === 'unverified',
        );
        await Promise.all(stale.map((f) => supabase.auth.mfa.unenroll({ factorId: f.id })));

        const { data, error: enrollError } = await supabase.auth.mfa.enroll({
          factorType: 'totp',
          friendlyName: 'Zirconix',
        });
        if (enrollError) throw enrollError;
        if (!alive) return;

        setFactorId(data.id);
        setSecret(data.totp.secret);
      } catch (e) {
        if (alive) setError(humanError(e));
      } finally {
        if (alive) setPreparing(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  async function verify() {
    if (!factorId) return;
    setError(null);
    setBusy(true);
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId,
      });
      if (challengeError) throw challengeError;

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
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

  if (preparing) return <Loading />;

  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <Text style={s.title}>Set up your authenticator</Text>
        <Text style={s.body}>
          Approving an entry of PKR 10 lac or more requires two-step verification. Add this key to
          Google Authenticator, Microsoft Authenticator, or 1Password, then enter the code it shows.
        </Text>

        {error ? <Banner tone="danger" title="Enrollment problem" body={error} /> : null}

        {secret ? (
          <Card style={s.secretCard}>
            <Text style={s.secretLabel}>SETUP KEY</Text>
            <Text style={s.secret} selectable>
              {secret.match(/.{1,4}/g)?.join(' ')}
            </Text>
            <Text style={s.secretHint}>
              Account name: Zirconix · Type: time-based
            </Text>
          </Card>
        ) : null}

        <Field
          label="Code from your authenticator"
          value={code}
          onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
          keyboardType="number-pad"
          textContentType="oneTimeCode"
          placeholder="000000"
          maxLength={6}
          style={s.codeInput}
        />

        <Button
          label="Confirm and finish"
          onPress={verify}
          loading={busy}
          disabled={code.length !== 6 || !factorId}
        />

        <Button
          label="Skip for now"
          variant="ghost"
          onPress={() => router.replace('/(tabs)/dashboard')}
          style={{ marginTop: space.sm }}
        />
        <Text style={s.footnote}>
          You can browse and log expenditures without this. You cannot approve another director's
          entry until it is set up.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: color.canvas },
  scroll: { padding: space.xl, paddingTop: space.xxl },
  title: { ...type.title, color: color.ink, marginBottom: space.sm },
  body: { ...type.body, color: color.inkMuted, marginBottom: space.xl, lineHeight: 22 },
  secretCard: { marginBottom: space.xl, backgroundColor: color.accentSoft, borderColor: color.accent },
  secretLabel: { ...type.micro, color: color.accent, marginBottom: space.sm },
  secret: {
    fontSize: 19,
    fontWeight: '700',
    color: color.ink,
    letterSpacing: 1.5,
    fontVariant: ['tabular-nums'],
    lineHeight: 28,
  },
  secretHint: { ...type.caption, color: color.inkMuted, marginTop: space.md },
  codeInput: {
    fontSize: 28,
    letterSpacing: 10,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    height: 64,
  },
  footnote: { ...type.caption, color: color.inkMuted, marginTop: space.md, lineHeight: 18 },
});
