import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSession } from '../lib/session';
import { color, space, type, radius } from '../lib/theme';
import { useRouter } from 'expo-router';

export default function ProfileScreen() {
  const { director, signOut } = useSession();
  const router = useRouter();

  const handleSignOut = async () => {
    await signOut();
    router.replace('/(auth)/sign-in');
  };

  if (!director) {
    return (
      <View style={styles.container}>
        <Text style={styles.value}>No director profile found.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.field}>
          <Text style={styles.label}>Name</Text>
          <Text style={styles.value}>{director.full_name}</Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Designation</Text>
          <Text style={styles.value}>
            {director.role === 'director'
              ? 'Director'
              : director.role === 'finance_officer'
              ? 'Finance Officer'
              : director.role === 'auditor'
              ? 'Auditor'
              : director.role}
          </Text>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <Text style={styles.value}>{director.email}</Text>
        </View>
      </View>

      <Pressable style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: space.xl,
    backgroundColor: color.canvas,
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.md,
    padding: space.lg,
    borderWidth: 1,
    borderColor: color.border,
    marginBottom: space.xl,
  },
  field: {
    marginBottom: space.lg,
  },
  label: {
    ...type.label,
    color: color.inkFaint,
    textTransform: 'uppercase',
    marginBottom: space.xs,
  },
  value: {
    ...type.body,
    color: color.ink,
    fontWeight: '500',
  },
  signOutButton: {
    backgroundColor: color.dangerSoft,
    padding: space.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: color.danger,
  },
  signOutText: {
    ...type.heading,
    color: color.danger,
  },
});
