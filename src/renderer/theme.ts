export const colors = {
  background: '#12181F',
  panel: '#1E2630',
  border: '#2A323D',
  primary: '#F0A63F',
  primaryInk: '#412402',
  secondary: '#2DD4BF',
  secondaryBg: '#04342C',
  success: '#6FCF8E',
  successBg: '#173404',
  error: '#E2574C',
  errorBg: '#3A1512',
  textPrimary: '#EDEFF2',
  textSecondary: '#8A94A3'
} as const

export const radii = {
  card: 8,
  window: 12,
  pill: 20
} as const

export const fonts = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", "Cascadia Mono", "SF Mono", Consolas, monospace'
} as const

export type ThemeColor = (typeof colors)[keyof typeof colors]
