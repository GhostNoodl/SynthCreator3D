import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base: './' keeps asset URLs relative so the build also works when wrapped
// by Tauri (file:// / custom protocol) later.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    // Tauri's devUrl points here; fail loudly instead of silently shifting ports
    port: 5173,
    strictPort: true,
  },
});
