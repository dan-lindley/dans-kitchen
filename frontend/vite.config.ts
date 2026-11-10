import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: resolve(__dirname, "../custom_components/dans_kitchen/frontend/dist"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        panel: resolve(__dirname, "src/panel.ts"),
        cards: resolve(__dirname, "src/cards.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
