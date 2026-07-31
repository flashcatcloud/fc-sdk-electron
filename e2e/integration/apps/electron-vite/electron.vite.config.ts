import { defineConfig } from 'electron-vite';
import { datadogVitePlugin } from '@flashcatcloud/electron-sdk/vite-plugin';

export default defineConfig({
  main: {
    plugins: [datadogVitePlugin()],
  },
  preload: {},
  renderer: {},
});
