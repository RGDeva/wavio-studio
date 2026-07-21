/** @type {import('tailwindcss').Config} */
const hsl = (v) => `hsl(var(${v}) / <alpha-value>)`;

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Existing keys, now token-driven with identical output (non-breaking).
        primary: {
          DEFAULT: hsl('--primary'),
          foreground: hsl('--primary-foreground'),
          muted: hsl('--primary-muted'),
        },
        accent: { DEFAULT: hsl('--accent'), foreground: hsl('--accent-foreground') },
        background: hsl('--background'),
        surface: hsl('--surface'),
        'surface-2': hsl('--surface-2'),
        'surface-3': hsl('--surface-3'),
        border: hsl('--border'),
        'border-subtle': hsl('--border-subtle'),
        'muted-fg': hsl('--muted-foreground'),
        // New semantic tokens.
        foreground: hsl('--foreground'),
        muted: { DEFAULT: hsl('--muted'), foreground: hsl('--muted-foreground') },
        input: hsl('--input'),
        secondary: { DEFAULT: hsl('--secondary'), foreground: hsl('--secondary-foreground') },
        destructive: { DEFAULT: hsl('--destructive'), foreground: hsl('--destructive-foreground') },
        warning: { DEFAULT: hsl('--warning'), foreground: hsl('--warning-foreground') },
        success: { DEFAULT: hsl('--success'), foreground: hsl('--success-foreground') },
        info: { DEFAULT: hsl('--info'), foreground: hsl('--info-foreground') },
        ring: hsl('--ring'),
        overlay: hsl('--overlay'),
        'waveform-played': hsl('--waveform-played'),
        'waveform-unplayed': hsl('--waveform-unplayed'),
        'waveform-cursor': hsl('--waveform-cursor'),
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      transitionTimingFunction: { out: 'var(--ease-out)' },
      fontFamily: {
        // Dense application text stays on the readable Inter / system stack.
        sans: ['Inter', 'system-ui', 'sans-serif'],
        // Jura is brand-level only (headings / project titles) — used selectively.
        brand: ['Jura', 'Inter', 'system-ui', 'sans-serif'],
        // Technical values: hashes, metadata, versions, states.
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
