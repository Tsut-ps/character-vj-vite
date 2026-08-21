import { defineConfig } from 'vite'

export default defineConfig({
  base: '/character-vj-vite/',
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        controller: 'controller.html',
      },
    },
  },
})
