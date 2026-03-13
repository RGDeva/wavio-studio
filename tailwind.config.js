/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: '#06B6D4',
        accent: '#8B5CF6',
        background: '#000000',
        surface: '#0A0A0A',
        'surface-2': '#111111',
        'surface-3': '#1A1A1A',
        border: '#1F1F1F',
        'muted-fg': '#6B7280',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
