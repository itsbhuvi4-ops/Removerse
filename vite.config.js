import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        admin: resolve(import.meta.dirname, "admin.html"),
        adminRoute: resolve(import.meta.dirname, "admin/index.html"),
        status: resolve(import.meta.dirname, "status.html"),
      },
    },
  },
});
