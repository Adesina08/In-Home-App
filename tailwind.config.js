/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./views/**/*.ejs", "./public/js/**/*.js"],
  safelist: [
    { pattern: /^(bg|text|border|from|to|ring)-(brand|slate|emerald|amber|red|violet|sky)(-\d+)?(\/\d+)?$/ },
    // New design tokens. Safelisted because they appear inside EJS ternaries,
    // which the JIT scanner cannot always resolve to a literal class name.
    { pattern: /^(bg|text|border|outline|ring)-(signal|unverified|verified)(-(soft|deep))?(\/\d+)?$/ },
    { pattern: /^(bg|text)-paper$/ },
    { pattern: /^font-(display|mono|sans)$/ },
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
        // Field mode: respondent + interviewer screens. Deep teal, used ONLY for
        // the single primary action on a screen. Never on the staff console --
        // there navy is the action colour and a second accent would compete.
        signal: {
          DEFAULT: "#0B7285",
          soft: "#E6F4F6",
          deep: "#083F4A",
        },
        // Answer provenance. Semantic, not decorative: `unverified` marks a value
        // the video AI produced that no person has confirmed, and it is meant to
        // be slightly uncomfortable to look at.
        unverified: { DEFAULT: "#B45309", soft: "#FEF6E7" },
        verified: { DEFAULT: "#047857", soft: "#ECFDF5" },
        // Field background. Warm off-white -- less glare than pure white on a
        // phone held outdoors.
        paper: "#FAF9F7",
      },
      fontFamily: {
        // Body/UI. Chosen for legibility at 14px on low-end Android.
        sans: ["Inter", "Segoe UI", "system-ui", "-apple-system", "sans-serif"],
        // Page titles and field-screen questions.
        display: ["Bricolage Grotesque", "Segoe UI", "system-ui", "sans-serif"],
        // Respondent codes, IDs, timestamps, counts. R01-0007 and R01-0001 are
        // hard to tell apart in a proportional face and staff scan columns of
        // them all day.
        mono: ["IBM Plex Mono", "ui-monospace", "monospace"],
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
