-- Отдельные дорожки места (гитара, бас, барабаны…) в дополнение к полному минусу.
-- Обрабатываются вместе с минусом: место становится open, когда готовы все дорожки.
CREATE TABLE spot_stems (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    spot_id       uuid     NOT NULL REFERENCES open_spots (id) ON DELETE CASCADE,
    position      smallint NOT NULL CHECK (position BETWEEN 1 AND 8),
    instrument_id text     NOT NULL,
    raw_key       text     NOT NULL DEFAULT '',
    stem_key      text     NOT NULL DEFAULT '',
    peaks         jsonb    NOT NULL DEFAULT '[]',
    duration_ms   int      NOT NULL DEFAULT 0,
    UNIQUE (spot_id, position)
);
