/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Mark Pro"', 'Inter', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      // Entrance animations used by the Toast (`animate-fade-in`) and the
      // appointment drawer (`animate-slide-in-right`). Neither sets a fill
      // mode, so no transform lingers after the animation — a lingering
      // transform would make the drawer the containing block for `fixed`
      // children such as ConfirmDialog.
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'slide-in-right': 'slide-in-right 200ms ease-out',
      },
      colors: {
        // Spill brand colors — canonical design-system token values
        spill: {
          black: '#000000',
          white: '#FFFFFF',
          // Grey scale
          grey: {
            100: '#F6F5F9',
            200: '#D2D2DA',
            400: '#86868D',
            600: '#2F2F32',
          },
          // Blue scale (links, focus, selection)
          blue: {
            100: '#E5EBFF',
            200: '#C7D4FF',
            400: '#8FABFF',
            800: '#0061E0',
            900: '#0C1964',
          },
          // Teal scale (brand, success)
          teal: {
            100: '#D6F5EF',
            200: '#A6EDE4',
            400: '#35D0B8',
            600: '#08BA9F',
          },
          // Red scale (danger)
          red: {
            100: '#F9D1CD',
            200: '#FFB1A8',
            400: '#FB7465',
            600: '#D72A28',
            800: '#981B1B',
          },
          // Yellow scale (warning)
          yellow: {
            100: '#FFF8E5',
            200: '#FFEBBD',
            400: '#F8CF5D',
            600: '#EDB007',
          },
        },
        // Primary color aliases (using blue)
        primary: {
          50: '#E8EDFF',
          100: '#E8EDFF',
          200: '#C8D5FF',
          300: '#A8C2FF',
          400: '#8DA9FF',
          500: '#0C3CAD',       // Main primary
          600: '#0C3CAD',
          700: '#0C2A8A',
          800: '#0C3CAD',
          900: '#0C1A66',
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
};
