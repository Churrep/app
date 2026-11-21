// Package likes — «Хочу поиграть», «Тебя лайкнули» и совпадения (взаимные лайки).
// Публичных счётчиков лайков нет нигде; отказ («Не сейчас») второй стороне не виден.
package likes

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"music/apperr"
	"music/profile"
)

const DailyLimit = 50

type Service struct {
	db *pgxpool.Pool
}

func NewService(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

type LikeResult struct {
	Matched bool
	MatchID string
}

// Like — «Хочу поиграть» человеку toID (videoID — видео, с которого лайкнули, можно пусто).
func (s *Service) Like(ctx context.Context, fromID, toID, videoID string, now time.Time) (LikeResult, error) {
	if fromID == toID {
		return LikeResult{}, apperr.Invalid("to_user_id", "Себе лайк поставить нельзя")
	}
	if !profile.IsUUID(toID) {
		return LikeResult{}, apperr.NotFound("Профиль не найден")
	}
	var ok bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND level > 0)`, toID).Scan(&ok); err != nil {
		return LikeResult{}, err
	}
	if !ok {
		return LikeResult{}, apperr.NotFound("Профиль не найден")
	}
	var video *string
	if profile.IsUUID(videoID) {
		video = &videoID
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return LikeResult{}, err
	}
	defer tx.Rollback(ctx)
	// Сериализуем лайки одного человека, чтобы лимит нельзя было обойти параллельными запросами.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "likes:"+fromID); err != nil {
		return LikeResult{}, err
	}

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM likes WHERE from_user_id = $1 AND to_user_id = $2)`, fromID, toID).Scan(&exists); err != nil {
		return LikeResult{}, err
	}
	if !exists {
		var today int
		dayStart := profile.Today(now).Add(-4 * time.Hour) // полночь по Саратову (UTC+4) в UTC
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM likes WHERE from_user_id = $1 AND created_at >= $2`, fromID, dayStart).Scan(&today); err != nil {
			return LikeResult{}, err
		}
		if today >= DailyLimit {
			return LikeResult{}, &apperr.Error{Status: http.StatusTooManyRequests, Code: "like_limit", Message: "На сегодня хватит, завтра ещё"}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO likes (from_user_id, to_user_id, source_video_id) VALUES ($1, $2, $3)`, fromID, toID, video); err != nil {
			return LikeResult{}, err
		}
	}

	// Взаимный лайк — совпадение (в том числе если вторая сторона раньше нажала «Не сейчас»).
	var reverse bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM likes WHERE from_user_id = $1 AND to_user_id = $2)`, toID, fromID).Scan(&reverse); err != nil {
		return LikeResult{}, err
	}
	res := LikeResult{}
	if reverse {
		a, b := fromID, toID
		if b < a {
			a, b = b, a
		}
		err := tx.QueryRow(ctx, `INSERT INTO matches (id, user_a_id, user_b_id) VALUES (gen_random_uuid(), $1, $2)
			ON CONFLICT (user_a_id, user_b_id) DO NOTHING RETURNING id::text`, a, b).Scan(&res.MatchID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if err := tx.QueryRow(ctx, `SELECT id::text FROM matches WHERE user_a_id = $1 AND user_b_id = $2`, a, b).Scan(&res.MatchID); err != nil {
				return LikeResult{}, err
			}
		case err != nil:
			return LikeResult{}, err
		}
		res.Matched = true
	}
	if err := tx.Commit(ctx); err != nil {
		return LikeResult{}, err
	}
	return res, nil
}

// Unlike отменяет лайк, пока нет совпадения.
func (s *Service) Unlike(ctx context.Context, fromID, toID string) error {
	if !profile.IsUUID(toID) {
		return apperr.NotFound("Профиль не найден")
	}
	if id, _ := s.matchWith(ctx, fromID, toID); id != "" {
		return apperr.Conflict("matched", "У вас уже совпадение — лайк не отменить")
	}
	_, err := s.db.Exec(ctx, `DELETE FROM likes WHERE from_user_id = $1 AND to_user_id = $2`, fromID, toID)
	return err
}

func (s *Service) matchWith(ctx context.Context, userID, otherID string) (string, error) {
	var id string
	err := s.db.QueryRow(ctx, `SELECT id::text FROM matches WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)`,
		userID, otherID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	return id, err
}

type Relation struct {
	Liked   bool   `json:"liked"`
	MatchID string `json:"match_id,omitempty"`
}

// Relation — для кнопки в профиле: «Хочу поиграть», «Отменить» или «Совпадение — написать».
func (s *Service) Relation(ctx context.Context, userID, otherID string) (Relation, error) {
	var r Relation
	if !profile.IsUUID(otherID) {
		return r, nil
	}
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM likes WHERE from_user_id = $1 AND to_user_id = $2)`, userID, otherID).Scan(&r.Liked); err != nil {
		return r, err
	}
	var err error
	r.MatchID, err = s.matchWith(ctx, userID, otherID)
	return r, err
}

type Incoming struct {
	Author     profile.Author
	LikedAt    time.Time
	PosterKey  string // превью последнего видео
	VideoType  string
	VideoPeaks []byte
}

// Incoming — «Тебя лайкнули»: кто лайкнул, кроме скрытых «Не сейчас» и тех, с кем уже совпадение.
func (s *Service) Incoming(ctx context.Context, userID string, now time.Time) ([]Incoming, error) {
	rows, err := s.db.Query(ctx, `SELECT `+profile.AuthorSQL("u")+`, l.created_at,
			coalesce(v.poster_key, ''), coalesce(v.type, ''), coalesce(v.peaks, '[]')
		FROM likes l JOIN users u ON u.id = l.from_user_id
		LEFT JOIN LATERAL (SELECT poster_key, type, peaks FROM videos
			WHERE user_id = u.id AND status = 'ready' AND deleted_at IS NULL
			ORDER BY is_pinned DESC, created_at DESC LIMIT 1) v ON true
		WHERE l.to_user_id = $1 AND l.dismissed_at IS NULL AND u.deleted_at IS NULL
		  AND NOT EXISTS (SELECT 1 FROM likes back WHERE back.from_user_id = $1 AND back.to_user_id = l.from_user_id)
		ORDER BY l.created_at DESC LIMIT 200`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Incoming, error) {
		var in Incoming
		var a profile.AuthorScan
		err := r.Scan(append(a.Dest(), &in.LikedAt, &in.PosterKey, &in.VideoType, &in.VideoPeaks)...)
		in.Author = a.Author(now)
		return in, err
	})
}

func (s *Service) IncomingCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM likes l JOIN users u ON u.id = l.from_user_id
		WHERE l.to_user_id = $1 AND l.dismissed_at IS NULL AND u.deleted_at IS NULL
		  AND NOT EXISTS (SELECT 1 FROM likes back WHERE back.from_user_id = $1 AND back.to_user_id = l.from_user_id)`, userID).Scan(&n)
	return n, err
}

// Dismiss — «Не сейчас»: убирает из списка, второй стороне ничего не сообщается.
func (s *Service) Dismiss(ctx context.Context, userID, fromID string) error {
	if !profile.IsUUID(fromID) {
		return apperr.NotFound("Лайк не найден")
	}
	_, err := s.db.Exec(ctx, `UPDATE likes SET dismissed_at = now() WHERE from_user_id = $1 AND to_user_id = $2 AND dismissed_at IS NULL`, fromID, userID)
	return err
}

type Match struct {
	ID           string
	Other        profile.Author
	CreatedAt    time.Time
	DMRestricted bool
}

var matchSQL = `SELECT m.id::text, m.created_at, ` + profile.AuthorSQL("u") + `,
		(SELECT birth_date FROM users WHERE id = $1)
	FROM matches m JOIN users u ON u.id = CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END
	WHERE (m.user_a_id = $1 OR m.user_b_id = $1) AND u.deleted_at IS NULL`

func scanMatch(r pgx.Row, now time.Time) (Match, error) {
	var m Match
	var a profile.AuthorScan
	var myBirth *time.Time
	err := r.Scan(append(append([]any{&m.ID, &m.CreatedAt}, a.Dest()...), &myBirth)...)
	m.Other = a.Author(now)
	me := profile.User{}
	if myBirth != nil {
		me.BirthDate = *myBirth
	}
	// Личные сообщения недоступны, если один из двоих 16–17 лет, а другой взрослый.
	m.DMRestricted = me.IsMinor(now) != a.Minor(now)
	return m, err
}

func (s *Service) Matches(ctx context.Context, userID string, now time.Time) ([]Match, error) {
	rows, err := s.db.Query(ctx, matchSQL+` ORDER BY m.created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Match, error) { return scanMatch(r, now) })
}

func (s *Service) GetMatch(ctx context.Context, userID, id string, now time.Time) (Match, error) {
	if !profile.IsUUID(id) {
		return Match{}, apperr.NotFound("Чат не найден")
	}
	m, err := scanMatch(s.db.QueryRow(ctx, matchSQL+` AND m.id = $2`, userID, id), now)
	if errors.Is(err, pgx.ErrNoRows) {
		return Match{}, apperr.NotFound("Чат не найден")
	}
	return m, err
}
