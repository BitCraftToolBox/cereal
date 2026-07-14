import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  ssr: false,
  server: {
    preset: "cloudflare-pages",
    cloudflare: {
      pages: {
        routes: {
          exclude: ["/_build/*"]
        }
      }
    },
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
