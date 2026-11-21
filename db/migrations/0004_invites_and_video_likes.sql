-- Разделяем два действия: лайк записи и предложение поиграть.
-- Взаимность больше не хранится: два встречных предложения (А → Б и Б → А) и есть совпадение.

-- «Хочу поиграть»: направленная пара, А → Б и Б → А — разные строки.
CREATE TABLE play_invites (
    from_user_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    to_user_id   uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    dismissed_at timestamptz, -- «Не сейчас»: скрыто из входящих, отправителю не сообщается
    PRIMARY KEY (from_user_id, to_user_id),
    CHECK (from_user_id <> to_user_id)
);
CREATE INDEX play_invites_to_idx ON play_invites (to_user_id, created_at DESC);
CREATE INDEX play_invites_from_day_idx ON play_invites (from_user_id, created_at);

-- Старые лайки ставились человеку и значили «хочу поиграть» — переносим их как предложения.
INSERT INTO play_invites (from_user_id, to_user_id, created_at, dismissed_at)
SELECT from_user_id, to_user_id, created_at, dismissed_at FROM likes;

-- У каждого совпадения должны быть оба направления. Если какого-то нет — дописываем,
-- чтобы после удаления matches ни одно совпадение не пропало.
INSERT INTO play_invites (from_user_id, to_user_id, created_at)
SELECT user_a_id, user_b_id, created_at FROM matches
ON CONFLICT DO NOTHING;
INSERT INTO play_invites (from_user_id, to_user_id, created_at)
SELECT user_b_id, user_a_id, created_at FROM matches
ON CONFLICT DO NOTHING;

DROP TABLE matches;
DROP TABLE likes;

-- Лайк конкретной записи. Автор записи — videos.user_id.
CREATE TABLE likes (
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    video_id   uuid        NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, video_id)
);
CREATE INDEX likes_video_idx ON likes (video_id);
