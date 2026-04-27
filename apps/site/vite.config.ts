import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/ripcord/' : '/',
  plugins: [react(), tailwindcss()],
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
  define: {
    VITE_APP_VERSION: JSON.stringify(process.env.RELEASE_VERSION ?? 'latest'),
  },
}));
