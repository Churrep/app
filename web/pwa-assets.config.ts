import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

// Генерирует иконки из public/logo.svg: npm run icons
const background = { background: '#FF6B3D' }

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: { ...minimal2023Preset.maskable, resizeOptions: background },
    apple: { ...minimal2023Preset.apple, resizeOptions: background },
  },
  images: ['public/logo.svg'],
})
