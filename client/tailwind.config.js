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
          DEFAULT: 'oklch(8.5% 0.004 260)',
          dark: 'oklch(6.5% 0.004 260)',
          light: 'oklch(13% 0.005 260)',
          lighter: 'oklch(17% 0.006 260)'
        },
        'surface': {
          DEFAULT: 'oklch(12% 0.005 260)',
          hover: 'oklch(15.5% 0.006 260)',
          active: 'oklch(19% 0.007 260)'
        },
        'border': {
          DEFAULT: 'oklch(24% 0.007 260)',
          light: 'oklch(31% 0.009 260)'
        }
      },
      fontFamily: {
        sans: ['"SF Pro Text"', '"SF Pro Display"', 'ui-sans-serif', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'system-ui', 'sans-serif'],
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
