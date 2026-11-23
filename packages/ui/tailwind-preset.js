/** Shared Tailwind preset: maps design tokens (CSS variables in styles/tokens.css) to utilities. */
const v = (name) => `hsl(var(--${name}) / <alpha-value>)`;
module.exports = {
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        background: v('background'),
        foreground: v('foreground'),
        card: { DEFAULT: v('card'), foreground: v('card-foreground') },
        muted: { DEFAULT: v('muted'), foreground: v('muted-foreground') },
        border: v('border'),
        input: v('input'),
        ring: v('ring'),
        primary: { DEFAULT: v('primary'), foreground: v('primary-foreground'), soft: v('primary-soft') },
        destructive: { DEFAULT: v('destructive'), foreground: v('destructive-foreground') },
        success: { DEFAULT: v('success'), soft: v('success-soft') },
        warning: { DEFAULT: v('warning'), soft: v('warning-soft') },
        danger: { DEFAULT: v('destructive'), soft: v('danger-soft') },
        sidebar: { DEFAULT: v('sidebar'), foreground: v('sidebar-foreground'), accent: v('sidebar-accent') },
      },
      borderRadius: { lg: '0.75rem', xl: '1rem', '2xl': '1.25rem' },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px hsl(var(--shadow) / 0.06), 0 1px 3px hsl(var(--shadow) / 0.04)',
        pop: '0 10px 30px hsl(var(--shadow) / 0.14)',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: { shimmer: 'shimmer 1.6s infinite' },
    },
  },
};
