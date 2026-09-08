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
        // Text hierarchy (P3-1d) — the named replacement for raw white/opacity.
        fg: {
          DEFAULT: hsl('--fg'),
          secondary: hsl('--fg-secondary'),
          tertiary: hsl('--fg-tertiary'),
          quaternary: hsl('--fg-quaternary'),
          disabled: hsl('--fg-disabled'),
        },
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
      backgroundColor: ({ theme }) => ({
        ...theme("colors"),
        // Elevation overlays (P3-1d). Same computed values the raw
        // `bg-white/N` utilities produced; named so the ladder is legible.
        "layer-1": "rgb(255 255 255 / 0.03)",
        "layer-2": "rgb(255 255 255 / 0.05)",
        "layer-3": "rgb(255 255 255 / 0.08)",
        "layer-4": "rgb(255 255 255 / 0.12)",
      }),
      borderColor: ({ theme }) => ({
        ...theme("colors"),
        DEFAULT: theme("colors.border"),
        // Hairline ladder (P3-1d), likewise value-preserving.
        "hairline": "rgb(255 255 255 / 0.05)",
        "hairline-strong": "rgb(255 255 255 / 0.10)",
        "hairline-focus": "rgb(255 255 255 / 0.20)",
      }),
      fontSize: {
        meta: ['var(--text-meta)', { lineHeight: '1.45' }],
        body: ['var(--text-body)', { lineHeight: '1.5' }],
        title: ['var(--text-title)', { lineHeight: '1.4' }],
        heading: ['var(--text-heading)', { lineHeight: '1.3' }],
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
