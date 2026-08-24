/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./views/**/*.ejs", "./public/js/**/*.js"],
  safelist: [
    { pattern: /^(bg|text|border|from|to|ring)-(brand|slate|emerald|amber|red|violet|sky)(-\d+)?(\/\d+)?$/ },
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#1F3864",
          50: "#EEF2FA",
          100: "#DCE5F4",
          200: "#B4C6E5",
          300: "#8CA7D6",
          400: "#4E71AE",
          light: "#2E5395",
          500: "#2E5395",
          600: "#254680",
          700: "#1F3864",
          800: "#182A4B",
          900: "#101C33",
        },
      },
      fontFamily: {
        sans: ["Segoe UI", "system-ui", "-apple-system", "sans-serif"],
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
      boxShadow: {
        card: "0 1px 2px 0 rgba(16,28,51,0.04), 0 1px 3px 0 rgba(16,28,51,0.06)",
        "card-hover": "0 4px 12px -2px rgba(16,28,51,0.10), 0 2px 4px -2px rgba(16,28,51,0.06)",
        pop: "0 10px 30px -8px rgba(16,28,51,0.25)",
      },
    },
  },
  plugins: [],
};
