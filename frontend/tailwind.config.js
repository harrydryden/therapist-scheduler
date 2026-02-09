/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Spill brand colors - updated palette
        spill: {
          black: '#000000',
          white: '#FFFFFF',
          // Grey scale
          grey: {
            100: '#F6F5F9',
            200: '#D3D3DB',
            400: '#707078',
            600: '#303033',
          },
          // Blue scale (primary)
          blue: {
            100: '#E8EDFF',
            200: '#C8D5FF',
            400: '#8DA9FF',
            800: '#0C3CAD',
            900: '#0C1A66',
          },
          // Teal scale
          teal: {
            100: '#D6F5EF',
            200: '#A4EDE3',
            400: '#35D0BA',
            600: '#08B89F',
          },
          // Red scale (errors, warnings)
          red: {
            100: '#F9D3CF',
            200: '#FFB0A8',
            400: '#FB7466',
            600: '#D82C29',
          },
          // Yellow scale (alerts, highlights)
          yellow: {
            100: '#FFF8E7',
            200: '#FFECBE',
            400: '#F8CF60',
            600: '#EFB108',
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
