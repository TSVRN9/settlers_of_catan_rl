import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages serves project sites under /<repo>/; CI sets VITE_BASE, local dev uses /.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  build: { target: "es2022", sourcemap: false },
});
