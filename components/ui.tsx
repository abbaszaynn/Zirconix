import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { color, radius, shadow, space, type } from '../lib/theme';
import { money } from '../lib/format';
import type { StatusTone } from '../lib/format';

export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function SectionTitle({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <View style={s.sectionTitle}>
      <Text style={s.sectionTitleText}>{children}</Text>
      {note ? <Text style={s.sectionNote}>{note}</Text> : null}
    </View>
  );
}

/**
 * Amounts are right-aligned and tabular so a column of figures can be scanned
 * vertically — the thing a director actually does with this screen.
 */
export function Money({
  amount,
  tone = 'neutral',
  size = 'body',
}: {
  amount: number | null | undefined;
  tone?: StatusTone;
  size?: 'body' | 'large' | 'display';
}) {
  const toneColor =
    tone === 'positive'
      ? color.positive
      : tone === 'warning'
        ? color.warning
        : tone === 'danger'
          ? color.danger
          : color.ink;

  return (
    <Text
      style={[
        s.money,
        size === 'large' && s.moneyLarge,
        size === 'display' && s.moneyDisplay,
        { color: toneColor },
      ]}
      numberOfLines={1}
    >
      {money(amount)}
    </Text>
  );
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  const palette = {
    positive: [color.positiveSoft, color.positive],
    warning: [color.warningSoft, color.warning],
    danger: [color.dangerSoft, color.danger],
    neutral: [color.surfaceSunken, color.inkMuted],
  }[tone];

  return (
    <View style={[s.pill, { backgroundColor: palette[0] }]}>
      <Text style={[s.pillText, { color: palette[1] }]}>{label.toUpperCase()}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const isDisabled = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        s.btn,
        variant === 'primary' && s.btnPrimary,
        variant === 'secondary' && s.btnSecondary,
        variant === 'danger' && s.btnDanger,
        variant === 'ghost' && s.btnGhost,
        pressed && !isDisabled && s.btnPressed,
        isDisabled && s.btnDisabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={variant === 'secondary' || variant === 'ghost' ? color.accent : '#fff'} />
      ) : (
        <Text
          style={[
            s.btnText,
            (variant === 'secondary' || variant === 'ghost') && { color: color.accent },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Field({
  label,
  hint,
  error,
  ...props
}: TextInputProps & { label: string; hint?: string; error?: string }) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={color.inkFaint}
        {...props}
        style={[s.input, !!error && s.inputError, props.style]}
      />
      {error ? (
        <Text style={s.fieldError}>{error}</Text>
      ) : hint ? (
        <Text style={s.fieldHint}>{hint}</Text>
      ) : null}
    </View>
  );
}

export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <View style={s.field}>
      <Text style={s.fieldLabel}>{label}</Text>
      <View style={s.choiceRow}>
        {options.map((o) => {
          const selected = o.value === value;
          return (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              onPress={() => onChange(o.value)}
              style={[s.choice, selected && s.choiceSelected]}
            >
              <Text style={[s.choiceText, selected && s.choiceTextSelected]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export function Row({
  label,
  sub,
  right,
  onPress,
}: {
  label: string;
  sub?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const body = (
    <View style={s.row}>
      <View style={s.rowMain}>
        <Text style={s.rowLabel} numberOfLines={1}>
          {label}
        </Text>
        {sub ? (
          <Text style={s.rowSub} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => pressed && s.rowPressed}>
      {body}
    </Pressable>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      <Text style={s.emptyBody}>{body}</Text>
    </View>
  );
}

export function Banner({
  tone = 'warning',
  title,
  body,
  action,
}: {
  tone?: StatusTone;
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  const palette = {
    positive: [color.positiveSoft, color.positive],
    warning: [color.warningSoft, color.warning],
    danger: [color.dangerSoft, color.danger],
    neutral: [color.accentSoft, color.accent],
  }[tone];

  return (
    <View style={[s.banner, { backgroundColor: palette[0], borderColor: palette[1] }]}>
      <Text style={[s.bannerTitle, { color: palette[1] }]}>{title}</Text>
      {body ? <Text style={s.bannerBody}>{body}</Text> : null}
      {action ? <View style={{ marginTop: space.md }}>{action}</View> : null}
    </View>
  );
}

export function Loading() {
  return (
    <View style={s.loading}>
      <ActivityIndicator color={color.accent} />
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    padding: space.lg,
    ...shadow.card,
  },
  sectionTitle: { marginBottom: space.md, marginTop: space.xl },
  sectionTitleText: { ...type.heading, color: color.ink },
  sectionNote: { ...type.caption, color: color.inkMuted, marginTop: 2 },

  money: { ...type.body, fontWeight: '600', fontVariant: ['tabular-nums'], textAlign: 'right' },
  moneyLarge: { fontSize: 19, fontWeight: '700' },
  moneyDisplay: { fontSize: 30, fontWeight: '700', letterSpacing: -0.6 },

  pill: {
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  pillText: { ...type.micro },

  btn: {
    height: 50,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  btnPrimary: { backgroundColor: color.accent },
  btnSecondary: { backgroundColor: color.accentSoft },
  btnDanger: { backgroundColor: color.danger },
  btnGhost: { backgroundColor: 'transparent' },
  btnPressed: { opacity: 0.85 },
  btnDisabled: { opacity: 0.45 },
  btnText: { ...type.label, fontSize: 15, color: '#fff' },

  field: { marginBottom: space.lg },
  fieldLabel: { ...type.label, color: color.ink, marginBottom: space.sm },
  input: {
    height: 50,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    backgroundColor: color.surface,
    color: color.ink,
    fontSize: 16,
  },
  inputError: { borderColor: color.danger },
  fieldHint: { ...type.caption, color: color.inkMuted, marginTop: space.xs },
  fieldError: { ...type.caption, color: color.danger, marginTop: space.xs },

  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  choice: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderStrong,
    backgroundColor: color.surface,
  },
  choiceSelected: { borderColor: color.accent, backgroundColor: color.accentSoft },
  choiceText: { ...type.body, color: color.inkMuted },
  choiceTextSelected: { color: color.accent, fontWeight: '600' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space.md,
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  rowPressed: { backgroundColor: color.surfaceSunken },
  rowMain: { flex: 1 },
  rowLabel: { ...type.body, color: color.ink, fontWeight: '500' },
  rowSub: { ...type.caption, color: color.inkMuted, marginTop: 2 },

  empty: { padding: space.xl, alignItems: 'center' },
  emptyTitle: { ...type.heading, color: color.ink, marginBottom: space.xs },
  emptyBody: { ...type.body, color: color.inkMuted, textAlign: 'center' },

  banner: {
    borderRadius: radius.md,
    borderWidth: 1,
    padding: space.lg,
    marginBottom: space.lg,
  },
  bannerTitle: { ...type.label },
  bannerBody: { ...type.body, color: color.ink, marginTop: space.xs, lineHeight: 21 },

  loading: { padding: space.xxl, alignItems: 'center' },
});
