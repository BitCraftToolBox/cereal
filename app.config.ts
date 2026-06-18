import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  ssr: false,
  server: {
    preset: "cloudflare-pages",
    watch: {
      ignored: ["scripts/**"]
    }
  },
  vite: {
    css: {
      postcss: "./postcss.config.js",
    },
    publicDir: "public",
  },
});
