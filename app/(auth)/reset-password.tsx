import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { supabase } from '../../lib/supabase';
import { humanError } from '../../lib/format';
import { color, space, type } from '../../lib/theme';
import { Banner, Button, Field } from '../../components/ui';

export default function ResetPassword() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });
      if (updateError) throw updateError;
      
      Alert.alert('Success', 'Your password has been updated.');
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
