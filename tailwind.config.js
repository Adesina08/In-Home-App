/** @type {import('tailwindcss').Config} */
module.exports = {
  // Class strategy, not media. The comps show dark for respondents and light
  // for parts of the console, so the theme is a product decision per surface
  // plus a user preference -- not whatever the OS happens to be set to.
  darkMode: "class",
  content: ["./views/**/*.ejs", "./public/js/**/*.js"],
  safelist: [
    { pattern: /^(bg|text|border|from|to|ring)-(brand|slate|emerald|amber|red|violet|sky)(-\d+)?(\/\d+)?$/ },
    // New design tokens. Safelisted because they appear inside EJS ternaries,
    // which the JIT scanner cannot always resolve to a literal class name.
    { pattern: /^(bg|text|border|outline|ring)-(signal|unverified|verified)(-(soft|deep))?(\/\d+)?$/ },
    { pattern: /^(bg|text)-paper$/ },
    { pattern: /^(bg|text|border|ring|placeholder)-night(-(base|raised|sunken|line|ink|muted))?(\/\d+)?$/ },
    // Safelist patterns cannot carry a variant prefix -- `variants` is how the
    // dark: form gets generated. Without this the dark theme compiles to
    // nothing whenever a class only appears inside an EJS conditional.
    { pattern: /^(bg|text|border|ring)-night(-(base|raised|sunken|line|ink|muted))?$/, variants: ["dark", "dark:hover"] },
    { pattern: /^(bg|text|border|ring)-(signal|slate|brand)(-(soft|deep|bright|\d+))?$/, variants: ["dark", "dark:hover"] },
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
        // Primary action colour across the whole product. Was teal; now the
        // brand blue from the approved comps. Kept under the name `signal` so
        // every existing usage moves with it rather than needing a sweep.
        signal: {
          DEFAULT: "#1D4ED8",
          soft: "#EFF4FF",
          deep: "#1E3A8A",
          bright: "#2563EB",
        },
        // Dark surfaces from the comps. Named by role, not by shade, so a
        // screen says what it is rather than how dark it is -- otherwise every
        // future tweak means renaming classes across dozens of views.
        night: {
          base: "#0A1628",     // page background
          raised: "#0F2038",   // cards on the page
          sunken: "#081222",   // inputs, wells
          line: "#1B3556",
          ink: "#F8FAFC",      // primary text
          muted: "#94A3B8",    // secondary text
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
