/** @type {import('tailwindcss').Config} */
module.exports = {
  presets: [require('@teamos/ui/tailwind-preset')],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};
