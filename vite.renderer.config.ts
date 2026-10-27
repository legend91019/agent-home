import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    rollupOptions: {
      input: { index: "index.html" },
    },
    outDir: ".vite/build/renderer/main_window",
    emptyOutDir: false,
  },
});
