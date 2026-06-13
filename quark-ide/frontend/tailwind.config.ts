import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'bg-deep': '#08080f',
        'bg-card': '#0d0d1a',
        'bg-panel': '#111127',
        'border-dark': '#1e1e3f',
        'neon': '#00ff88',
        'violet': '#7c3aed',
        'text-primary': '#e2e8f0',
        'text-muted': '#6b7280',
        'error': '#ff4560',
        'warning': '#ffa500',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '6px',
      },
    },
  },
  plugins: [],
};

export default config;
