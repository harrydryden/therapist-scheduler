/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Spill brand colors
        spill: {
          navy: '#1e3a5f',      // Dark navy blue (headers, dark accents)
          blue: '#0099ff',      // Bright blue (primary actions, links)
          aqua: '#66d9e8',      // Light aqua/cyan (hover states, secondary)
          mint: '#96f2d7',      // Mint green (success, highlights)
          teal: '#00b894',      // Teal/green (CTA buttons, accents)
        },
        primary: {
          50: '#e6f7ff',
          100: '#b3e6ff',
          200: '#80d4ff',
          300: '#4dc3ff',
          400: '#1ab2ff',
          500: '#0099ff',       // Bright blue - main
          600: '#007acc',
          700: '#005c99',
          800: '#003d66',
          900: '#1e3a5f',       // Navy
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
