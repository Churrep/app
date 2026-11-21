# Бэкенд PWA для музыкантов

Вход, онбординг и профиль; видео и лента; «недостающая дорожка»; карта репточек. Приложение только для Саратова: города в данных нет. Go 1.26, PostgreSQL 17 + PostGIS, FFmpeg.

## Запуск

Проще всего — в Docker: база и сервер с FFmpeg внутри.

```sh
docker compose up -d --build      # база + сервер на localhost:8080
docker compose logs -f app        # лог сервера: здесь код для входа
docker compose exec app seed      # тестовые точки для карты
docker compose up -d --build app  # пересобрать сервер после изменений в коде
```

Без Docker (нужны ffmpeg и ffprobe в PATH, иначе загрузки отключены):

```sh
docker compose up -d --wait postgres
DATABASE_URL='postgres://music:music@localhost:5432/music?sslmode=disable' \
  SMS_LOG_CODES=true COOKIE_SECURE=false go run .
```

Тестовые точки для карты (15 штук, помечены «[Тест]»): `DATABASE_URL=... go run ./cmd/seed`.

Для видео и дорожек нужны `ffmpeg` и `ffprobe` в PATH (или пути в `FFMPEG`/`FFPROBE`). Без них сервер
работает, но загрузки отвечают 503. Файлы хранятся на диске в `MEDIA_DIR`; для прода — S3-совместимое хранилище в РФ.

Миграции из `db/migrations` применяются сами при старте. Без `DATABASE_URL` сервер работает на памяти
(данные пропадут при перезапуске).

Тесты:

```sh
go test ./...                       # на памяти
TEST_DATABASE_URL='postgres://music:music@localhost:5432/music_test?sslmode=disable' go test ./...   # на отдельной базе music_test: тесты её очищают
```

Код для входа приходит по СМС через sms.ru, если задан `SMSRU_API_ID`. Без него, с `SMS_LOG_CODES=true`,
код пишется в лог сервера. Без одного из двух сервер не стартует.

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `ADDR` | `:8080` | адрес сервера |
| `DATABASE_URL` | — | строка подключения к PostgreSQL; без неё — хранение в памяти |
| `SMSRU_API_ID` | — | ключ API sms.ru: коды приходят настоящими СМС (платно) |
| `SMSRU_TEST` | — | `true`: sms.ru проверяет запросы, но не отправляет СМС и не списывает деньги |
| `SMSRU_FROM` | — | имя отправителя, если согласовано в sms.ru |
| `SMS_LOG_CODES` | — | `true`: писать СМС-коды в лог (только разработка, если нет `SMSRU_API_ID`) |
| `COOKIE_SECURE` | `true` | `false` для локальной работы по http |
| `TRUST_PROXY` | `false` | `true`: брать IP клиента из `X-Real-IP` (за nginx) |
| `TELEGRAM_BOT_TOKEN` | — | токен бота для Telegram Login; без него вход через Telegram выключен |
| `MEDIA_DIR` | `data/media` | где хранить загруженные и обработанные файлы |
| `MEDIA_SECRET` | случайный | ключ подписи ссылок на файлы; без него ссылки ломаются при перезапуске |
| `MEDIA_BASE_URL` | `/api/media` | префикс ссылок на файлы для фронтенда |
| `FFMPEG`, `FFPROBE` | `ffmpeg`, `ffprobe` | пути к программам |

Фронтенд должен ходить в API с того же домена (в разработке — через proxy в Vite), CORS не настроен.
Все POST/PATCH/DELETE — только с `Content-Type: application/json`, загрузки файлов — `multipart/form-data`
с заголовком `X-Upload: 1` (защита от CSRF). Загрузок не больше 20 в час на человека.

## API

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/catalog` | справочники: инструменты, жанры, цели, уровни |
| POST | `/auth/otp` | `{"phone"}` — отправить код (раз в 60 с, до 5 в час) |
| POST | `/auth/verify` | `{"phone","code"}` — войти; ставит httpOnly cookie `session` |
| POST | `/auth/telegram` | данные виджета Telegram Login как есть |
| POST | `/auth/logout` | выйти |
| GET | `/me` | свой профиль; `onboarding.next_step` — следующий шаг анкеты |
| PATCH | `/me` | изменить поля профиля (только переданные) |
| GET | `/users/{id}` | чужой профиль (нужна заполненная анкета) |
| GET | `/media/{key}?exp=&sig=` | файл по подписанной ссылке (с поддержкой Range) |
| GET | `/feed?cursor=&instrument=&genre=&looking_for=&level_min=&level_max=` | лента чужих готовых записей |
| POST | `/videos` | загрузка записи: `file`, `type` (video/audio), `tag`, `caption`, `recorded_at` |
| GET/PATCH/DELETE | `/videos/{id}` | запись; PATCH `{"caption","is_pinned"}` |
| GET | `/me/videos`, `/users/{id}/videos` | записи: свои во всех статусах, чужие — только готовые |
| POST | `/bands`, GET `/me/bands` | группы |
| GET | `/spots?scope=mine` | открытые места под мои инструменты или места моих групп |
| POST | `/spots` | новое место: `file` (минус), `band_id`, `instrument_id`, `bpm`, `key`, `genre_id`, `description`, `deadline`, `own_song=true` |
| GET | `/spots/{id}`, POST `/spots/{id}/close` | место; закрыть |
| POST | `/spots/{id}/responses` | отклик: `file` (WAV партии), `offset_ms`, `start_ms`, `gain_backing`, `gain_track` |
| GET | `/spots/{id}/responses` | отклики (только участникам группы) |
| PATCH | `/responses/{id}` | `{"status":"invited"\|"rejected"}` |
| GET | `/me/responses` | мои отклики |
| GET | `/venues?type=&price_min=&price_max=&has_drums=1&has_backline=1&open_now=1&bbox=` | точки |
| GET | `/venues/{id}`, POST `/venues/{id}/report`, POST `/venues/suggest` | точка; ошибка; предложить новую |

Обработка медиа идёт в фоне (2 потока): видео → H.264/AAC MP4 до 720×1280 + кадр-превью + волна; звук и минусы → AAC;
отклик сводится с фрагментом минуса с учётом сдвига и громкостей. Статус `processing` → `ready`/`sent` или `failed`
с понятной ошибкой. Незаконченные задачи подхватываются после перезапуска.

Шаги онбординга по порядку: `birth_date` (вместе с `consent: true`), `name`, `instruments`, `level`,
`genres`, `looking_for`. Репертуар, первое видео и установка на экран пропускаются и в `next_step` не входят.

Ошибки: `{"error": "код", "message": "текст для пользователя", "field": "поле"}`.

Правила, которые уже соблюдаются:
- регистрация только с 16 лет, дату рождения после сохранения поменять нельзя;
- без согласия на обработку ПДн дата рождения не сохраняется, дата согласия хранится;
- у 16–17-летних район в чужом профиле скрыт всегда; возраст показывается, только если человек разрешил;
- `dm_restricted: true`, если один из двоих несовершеннолетний, а другой взрослый.

## Фронтенд (PWA)

React + TypeScript + Vite, PWA через vite-plugin-pwa. Лежит в `web/`. Нужен Node.js 24.

```sh
cd web
npm install
npm run dev        # http://localhost:5173, запросы /api/* уходят на Go-сервер :8080
npm run build      # сборка в web/dist
npm run preview    # собранная версия с service worker, http://localhost:4173
npm run dev:phone  # HTTPS-версия для телефона в той же Wi-Fi: камера и микрофон работают (принять предупреждение о сертификате)
npm run icons      # перегенерировать иконки из public/logo.svg
```

Вход через Telegram показывается, если задан `VITE_TELEGRAM_BOT` (имя бота без @) в `web/.env.local`.

В проде nginx отдаёт `web/dist` и проксирует `/api/*` на Go-сервер, отрезая префикс `/api`.
Без HTTPS приложение не ставится на экран и не получает push.

Готово: вход, онбординг (дата рождения и согласие, имя, инструменты, уровень, жанры и цели, что ищешь,
установка на экран), свой и чужой профиль, редактирование, настройки (тема, приватность, выход),
таб-бар из пяти разделов, офлайн-состояние; запись видео и звука (отсчёт, лимит 60 с / кавер 30 с,
прерывание при сворачивании), лента с фильтрами и записи в профиле; «недостающая дорожка» (группы, места,
запись партии поверх минуса через AudioWorklet с метрономом, калибровкой задержки, сдвигом ±300 мс и громкостями,
отклики для группы); карта точек (MapLibre + OpenStreetMap, кластеры, фильтры, карточка, «Я здесь» только с 18).
Не сделаны: лайки и совпадения, чаты, жалобы и модерация, push.
Карта — OpenFreeMap (бесплатно, без ключа); тайл-сервер самого OSM такие приложения блокирует.
Текст политики ПДн на `/privacy` — заглушка, до запуска нужен юридически проверенный.

## Структура

- `auth/` — нормализация телефона, СМС-коды, сессии (память и PostgreSQL), проверка Telegram Login
- `profile/` — модель пользователя, справочники, валидация, хранилище (память и PostgreSQL)
- `db/` — подключение к базе и миграции
- `media/` — хранилище файлов, подписанные ссылки, FFmpeg, фоновая очередь
- `videos/`, `tracks/`, `venues/` — записи и лента, группы и дорожки, точки на карте
- `cmd/seed/` — тестовые точки для карты
- `server/` — HTTP-обработчики
- `user/` — старый вход по логину и паролю, в новой схеме не используется

## Что дальше

- сиды с тестовыми данными (30 музыкантов, 5 групп, 15 точек)
- СМС-коды хранятся в памяти: для нескольких копий сервера перенести их в Redis или базу
- реальный СМС-провайдер вместо `auth.LogSender`
- загрузка фото в S3 (сейчас `photo_url` принимает любую https-ссылку)
- привязка Telegram к аккаунту с телефоном (`/telegram/link`)
- фронтенд PWA
