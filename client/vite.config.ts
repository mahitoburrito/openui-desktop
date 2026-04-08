import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverPort = process.env.SERVER_PORT || process.env.PORT || 6968;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://localhost:${serverPort}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${serverPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
