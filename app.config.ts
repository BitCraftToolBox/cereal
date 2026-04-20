import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  ssr: false,
  server: {
    preset: "cloudflare-pages",
  },
  vite: {
    css: {
      postcss: "./postcss.config.js",
    },
    publicDir: "public",
  },
});
