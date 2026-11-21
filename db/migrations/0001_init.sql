CREATE TABLE users (
    id                     uuid PRIMARY KEY,
    phone                  text,
    telegram_id            bigint,
    telegram_username      text        NOT NULL DEFAULT '',
    name                   text        NOT NULL DEFAULT '',
    birth_date             date,
    district               text        NOT NULL DEFAULT '',
    photo_url              text        NOT NULL DEFAULT '',
    level                  smallint    NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 5),
    goals                  text[]      NOT NULL DEFAULT '{}',
    looking_for            text        NOT NULL DEFAULT '',
    looking_for_instrument text        NOT NULL DEFAULT '',
    show_age               boolean     NOT NULL DEFAULT false,
    show_district          boolean     NOT NULL DEFAULT true,
    theme                  text        NOT NULL DEFAULT 'dark',
    consent_at             timestamptz,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    deleted_at             timestamptz
);

-- Один живой аккаунт на телефон и на Telegram; удалённые не мешают зарегистрироваться заново.
CREATE UNIQUE INDEX users_phone_key ON users (phone) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_telegram_id_key ON users (telegram_id) WHERE deleted_at IS NULL;

CREATE TABLE user_instruments (
    user_id       uuid     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    instrument_id text     NOT NULL,
    is_main       boolean  NOT NULL DEFAULT false,
    position      smallint NOT NULL,
    PRIMARY KEY (user_id, instrument_id)
);
CREATE UNIQUE INDEX user_instruments_one_main ON user_instruments (user_id) WHERE is_main;

CREATE TABLE user_genres (
    user_id  uuid     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    genre_id text     NOT NULL,
    position smallint NOT NULL,
    PRIMARY KEY (user_id, genre_id)
);
CREATE INDEX user_genres_genre_idx ON user_genres (genre_id);

CREATE TABLE sessions (
    token_hash bytea       PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------- Лента ----------

-- Видео и аудио музыкантов для ленты.
CREATE TABLE videos (
    id          uuid PRIMARY KEY,
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type        text        NOT NULL CHECK (type IN ('video', 'audio')),
    tag         text        NOT NULL CHECK (tag IN ('own', 'improv', 'exercise', 'cover')),
    caption     text        NOT NULL DEFAULT '',
    duration_ms int         NOT NULL DEFAULT 0,
    raw_key     text        NOT NULL DEFAULT '',
    media_key   text        NOT NULL DEFAULT '',
    poster_key  text        NOT NULL DEFAULT '',
    peaks       jsonb       NOT NULL DEFAULT '[]',
    is_pinned   boolean     NOT NULL DEFAULT false,
    status      text        NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),
    error       text        NOT NULL DEFAULT '',
    recorded_at timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);
CREATE INDEX videos_feed_idx ON videos (created_at DESC, id DESC) WHERE status = 'ready' AND deleted_at IS NULL;
CREATE INDEX videos_user_idx ON videos (user_id, created_at DESC);
CREATE UNIQUE INDEX videos_one_pinned ON videos (user_id) WHERE is_pinned AND deleted_at IS NULL;

-- ---------- Лайки и уведомления ----------

-- «Хочу поиграть»: лайк ставится человеку, а не видео. Повторный лайк того же человека ничего не меняет.
CREATE TABLE likes (
    from_user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    to_user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    source_video_id uuid        REFERENCES videos (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    dismissed_at    timestamptz, -- «Не сейчас»: скрыто из «Тебя лайкнули», второй стороне не сообщается
    PRIMARY KEY (from_user_id, to_user_id),
    CHECK (from_user_id <> to_user_id)
);
CREATE INDEX likes_to_idx ON likes (to_user_id, created_at DESC);
CREATE INDEX likes_from_day_idx ON likes (from_user_id, created_at);

-- Взаимный лайк. Пара хранится упорядоченно (user_a < user_b), чтобы не было дублей.
CREATE TABLE matches (
    id         uuid PRIMARY KEY,
    user_a_id  uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_b_id  uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_a_id, user_b_id),
    CHECK (user_a_id < user_b_id)
);
CREATE INDEX matches_b_idx ON matches (user_b_id);

-- Подписки браузеров на push-уведомления (Web Push, VAPID).
CREATE TABLE push_subscriptions (
    endpoint   text PRIMARY KEY,
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    p256dh     text        NOT NULL,
    auth       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- ---------- Группы и «недостающая дорожка» ----------

CREATE TABLE bands (
    id         uuid PRIMARY KEY,
    name       text        NOT NULL,
    genre_ids  text[]      NOT NULL DEFAULT '{}',
    created_by uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE band_members (
    band_id   uuid        NOT NULL REFERENCES bands (id) ON DELETE CASCADE,
    user_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role      text        NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    joined_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (band_id, user_id)
);
CREATE INDEX band_members_user_idx ON band_members (user_id);

-- Недостающая дорожка: песня группы без одной партии.
CREATE TABLE open_spots (
    id                  uuid PRIMARY KEY,
    band_id             uuid        NOT NULL REFERENCES bands (id) ON DELETE CASCADE,
    instrument_id       text        NOT NULL,
    song_title          text        NOT NULL DEFAULT '',
    raw_key             text        NOT NULL DEFAULT '',
    backing_key         text        NOT NULL DEFAULT '',
    backing_peaks       jsonb       NOT NULL DEFAULT '[]',
    backing_duration_ms int         NOT NULL DEFAULT 0,
    bpm                 smallint    NOT NULL CHECK (bpm BETWEEN 30 AND 300),
    key                 text        NOT NULL DEFAULT '',
    genre_id            text        NOT NULL,
    description         text        NOT NULL DEFAULT '',
    deadline            date,
    own_song_confirmed  boolean     NOT NULL CHECK (own_song_confirmed),
    status              text        NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'open', 'closed', 'failed')),
    error               text        NOT NULL DEFAULT '',
    created_by          uuid        REFERENCES users (id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX open_spots_open_idx ON open_spots (instrument_id, created_at DESC) WHERE status = 'open';
CREATE INDEX open_spots_band_idx ON open_spots (band_id, created_at DESC);

CREATE TABLE spot_responses (
    id                uuid PRIMARY KEY,
    spot_id           uuid        NOT NULL REFERENCES open_spots (id) ON DELETE CASCADE,
    user_id           uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    raw_key           text        NOT NULL DEFAULT '',
    track_key         text        NOT NULL DEFAULT '',
    track_peaks       jsonb       NOT NULL DEFAULT '[]',
    track_duration_ms int         NOT NULL DEFAULT 0,
    offset_ms         int         NOT NULL DEFAULT 0 CHECK (offset_ms BETWEEN -300 AND 300),
    start_ms          int         NOT NULL DEFAULT 0 CHECK (start_ms >= 0),
    gain_backing      real        NOT NULL DEFAULT 1 CHECK (gain_backing BETWEEN 0 AND 2),
    gain_track        real        NOT NULL DEFAULT 1 CHECK (gain_track BETWEEN 0 AND 2),
    mix_key           text        NOT NULL DEFAULT '',
    status            text        NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'sent', 'invited', 'rejected', 'failed')),
    error             text        NOT NULL DEFAULT '',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (spot_id, user_id)
);
CREATE INDEX spot_responses_user_idx ON spot_responses (user_id, created_at DESC);
