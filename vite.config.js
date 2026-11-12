import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// Relative base + hash links means the build works on any GitHub Pages path.
export default defineConfig({ plugins: [react()], base: './' });
