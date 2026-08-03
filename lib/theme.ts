/**
 * Zirconix design tokens.
 *
 * Sober institutional finance: light-first, high contrast, dense numerics.
 * Colour carries meaning here — it is reserved for entry status and for the
 * accountability gap. Nothing is coloured for decoration, because on this screen
 * a coloured number has to mean "look at this".
 */

export const color = {
  canvas: '#F4F6F8',
  surface: '#FFFFFF',
  surfaceSunken: '#EEF1F5',

  ink: '#0F1B2A',
  inkMuted: '#5B6B7C',
  inkFaint: '#8C9AA9',

  border: '#DDE3EA',
  borderStrong: '#C2CCD8',

  accent: '#1B4D8F',
  accentSoft: '#E8EFF8',

  // Status. Deliberately desaturated — these sit next to numbers that must stay
  // readable in direct sunlight at a mine site.
  positive: '#0F7B4F',
  positiveSoft: '#E4F2EB',
  warning: '#9A5B00',
  warningSoft: '#FBF0DF',
  danger: '#A3231C',
  dangerSoft: '#FBEAE9',

  overlay: 'rgba(15, 27, 42, 0.45)',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

export const type = {
  // Amounts use tabular figures everywhere so columns of money line up.
  mono: {
    fontVariant: ['tabular-nums'] as const,
  },
  display: { fontSize: 30, fontWeight: '700' as const, letterSpacing: -0.6 },
  title: { fontSize: 20, fontWeight: '700' as const, letterSpacing: -0.3 },
  heading: { fontSize: 16, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '600' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  micro: { fontSize: 11, fontWeight: '600' as const, letterSpacing: 0.4 },
} as const;

export const shadow = {
  card: {
    shadowColor: '#0F1B2A',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
} as const;
