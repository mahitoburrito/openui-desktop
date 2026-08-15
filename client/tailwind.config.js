/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'canvas': {
          DEFAULT: 'oklch(14.5% 0.006 255)',
          dark: 'oklch(12% 0.006 255)',
          light: 'oklch(17% 0.007 255)',
          lighter: 'oklch(20% 0.008 255)'
        },
        'surface': {
          DEFAULT: 'oklch(17% 0.007 255)',
          hover: 'oklch(19.5% 0.008 255)',
          active: 'oklch(22.5% 0.009 255)'
        },
        'border': {
          DEFAULT: 'oklch(29% 0.009 255)',
          light: 'oklch(34% 0.01 255)'
        },
        'accent': {
          DEFAULT: 'oklch(67% 0.13 250)',
          soft: 'oklch(67% 0.13 250 / 0.14)'
        }
      },
      fontFamily: {
        sans: ['"Founders Grotesk"', '"Archivo Variable"', 'ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"SF Mono"', 'ui-monospace', '"Cascadia Code"', 'Menlo', 'monospace'],
      },
      boxShadow: {
        'node': '0 2px 8px rgba(0, 0, 0, 0.3)',
        'node-hover': '0 4px 16px rgba(0, 0, 0, 0.4)',
        'glow': '0 0 20px var(--glow-color)',
      }
    },
  },
  plugins: [],
}
