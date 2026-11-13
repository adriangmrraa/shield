import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // Shield dev server (npm run shield:dev) — PORT comes from .env, default 3000.
  const shieldTarget = `http://localhost:${env.PORT ?? "3000"}`;

  // Order matters: the shield API/socket go to the shield dev server while the
  // editorial app keeps its own /api and /socket.io backend.
  const proxy = {
    "/api/shield": {
      target: shieldTarget,
      changeOrigin: true,
    },
    "/shield/socket.io": {
      target: shieldTarget,
      changeOrigin: true,
      ws: true,
    },
    "/api": {
      target: "http://localhost:3001",
      changeOrigin: true,
    },
    "/socket.io": {
      target: "ws://localhost:3001",
      ws: true,
    },
  };

  return {
    plugins: [react()],
    root: ".",
    build: {
      outDir: "dist/client",
    },
    server: {
      allowedHosts: true,
      proxy,
    },
    // `vite preview` serves the production build with the same proxy table so
    // the smoke path works identically off the built bundle.
    preview: {
      proxy,
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src/client"),
      },
    },
  };
});
