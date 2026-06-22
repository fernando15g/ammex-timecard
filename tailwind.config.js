/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        steel: "#1c2127",
        graphite: "#2b323c",
        safety: "#ff6a13",
        safetyDark: "#e25600",
        rebar: "#8a9099",
        concrete: "#f4f3f0",
        line: "#3a414c",
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};
