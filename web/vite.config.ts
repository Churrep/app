import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { VitePWA } from 'vite-plugin-pwa'

// Фронтенд ходит в API по /api/*, а сервер на Go отвечает без префикса.
// В разработке это делает proxy ниже, в проде — nginx.
declare const process: { env: Record<string, string | undefined> }

const apiProxy = {
  '/api': {
    target: process.env.API_TARGET ?? 'http://localhost:8080',
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
}

const tunnelHosts = ['.trycloudflare.com', '.lhr.life', '.localhost.run', '.serveo.net', '.serveousercontent.com']

export default defineConfig({
  plugins: [
    // npm run dev:phone — HTTPS с самоподписанным сертификатом: камера и микрофон на телефоне работают
    // только по защищённому адресу. Телефон один раз покажет предупреждение — его нужно принять.
    ...(process.env.HTTPS ? [basicSsl()] : []),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'logo.svg'],
      manifest: {
        name: 'Джем — музыканты Саратова',
        short_name: 'Джем',
        description: 'Найди, с кем играть в Саратове',
        lang: 'ru',
        start_url: '/feed',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#0E0E11',
        background_color: '#0E0E11',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Оболочка приложения кешируется целиком, API — никогда.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        importScripts: ['push-sw.js'],
      },
    }),
  ],
  // Временные ссылки для общего доступа (scripts/share.sh): Cloudflare или localhost.run.
  server: { proxy: apiProxy, allowedHosts: tunnelHosts },
  preview: { proxy: apiProxy, allowedHosts: tunnelHosts },
})
