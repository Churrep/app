#!/bin/sh
# Общий доступ к приложению по временной HTTPS-ссылке.
# Собирает сайт, запускает его на порту 4173 и открывает туннель:
# сначала Cloudflare (https://….trycloudflare.com), если он отказал — localhost.run (https://….lhr.life).
# Ссылка работает, пока открыто это окно; при каждом запуске она новая. Остановить — Ctrl+C.
# Постоянное имя через serveo.net: SERVEO_NAME=jamsaratov ./share.sh
# Сервер и база должны быть запущены: docker compose up -d
set -e
cd "$(dirname "$0")/../web"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"

npm run build
npx vite preview --port 4173 --strictPort &
PREVIEW=$!
trap 'kill $PREVIEW 2>/dev/null' EXIT
trap 'exit 0' INT TERM
sleep 2
echo

if [ -n "$SERVEO_NAME" ]; then
  echo "Туннель serveo.net с именем $SERVEO_NAME. Если serveo попросит войти по ссылке — открой её, войди и запусти скрипт ещё раз."
  ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
    -R "$SERVEO_NAME:80:localhost:4173" serveo.net
  exit 0
fi

echo "Пробую туннель Cloudflare. Ссылка появится ниже в рамке: https://….trycloudflare.com"
if command -v cloudflared >/dev/null && cloudflared tunnel --no-autoupdate --url http://localhost:4173; then
  exit 0
fi

echo
echo "Cloudflare не выдал ссылку — открываю туннель через localhost.run."
echo "Ссылка появится ниже: строка https://….lhr.life"
ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \
  -R 80:localhost:4173 nokey@localhost.run
