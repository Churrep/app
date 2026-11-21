// Package likes — два независимых действия:
//   - лайк записи («Нравится») — ставится конкретной записи, на знакомства не влияет;
//   - предложение «Хочу поиграть» — ставится человеку. Два встречных предложения — это совпадение,
//     отдельно оно не хранится.
//
// Публичных счётчиков нет нигде; «Не сейчас» отправителю не виден.
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

// DailyLimit — сколько новых предложений можно отправить за сутки.
const DailyLimit = 50

type Service struct {
	db *pgxpool.Pool
}

func NewService(db *pgxpool.Pool) *Service {
	return &Service{db: db}
}

// ---------- Лайки записей ----------

// LikeVideo — лайк чужой готовой записи. Повторный лайк ничего не меняет.
func (s *Service) LikeVideo(ctx context.Context, userID, videoID string) error {
	if !profile.IsUUID(videoID) {
		return apperr.NotFound("Запись не найдена")
	}
	var author string
	err := s.db.QueryRow(ctx, `SELECT v.user_id::text FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.id = $1 AND v.status = 'ready' AND v.deleted_at IS NULL AND u.deleted_at IS NULL`, videoID).Scan(&author)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("Запись не найдена")
	}
	if err != nil {
		return err
	}
	if author == userID {
		return apperr.Invalid("video_id", "Свою запись лайкнуть нельзя")
	}
	_, err = s.db.Exec(ctx, `INSERT INTO likes (user_id, video_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, userID, videoID)
	return err
}

// UnlikeVideo снимает лайк записи. Если лайка не было — ничего страшного.
func (s *Service) UnlikeVideo(ctx context.Context, userID, videoID string) error {
	if !profile.IsUUID(videoID) {
		return apperr.NotFound("Запись не найдена")
	}
	_, err := s.db.Exec(ctx, `DELETE FROM likes WHERE user_id = $1 AND video_id = $2`, userID, videoID)
	return err
}

// ---------- Предложения «Хочу поиграть» ----------

type InviteResult struct {
	Mutual bool // встречное предложение уже есть — совпадение
}

// pairLock сериализует предложения одной пары (в любую сторону): если двое нажмут одновременно,
// второй увидит строку первого и сразу получит «взаимно».
func pairLock(ctx context.Context, tx pgx.Tx, a, b string) error {
	if b < a {
		a, b = b, a
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "invite:"+a+":"+b)
	return err
}

// Invite — «Хочу поиграть» от fromID к toID. Повторное предложение ничего не меняет.
func (s *Service) Invite(ctx context.Context, fromID, toID string, now time.Time) (InviteResult, error) {
	if fromID == toID {
		return InviteResult{}, apperr.Invalid("to_user_id", "Себе предложение отправить нельзя")
	}
	if !profile.IsUUID(toID) {
		return InviteResult{}, apperr.NotFound("Профиль не найден")
	}
	var ok bool
	if err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL AND level > 0)`, toID).Scan(&ok); err != nil {
		return InviteResult{}, err
	}
	if !ok {
		return InviteResult{}, apperr.NotFound("Профиль не найден")
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return InviteResult{}, err
	}
	defer tx.Rollback(ctx)
	// Сначала лимит отправителя (чтобы его нельзя было обойти параллельными запросами), потом пара.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "invites:"+fromID); err != nil {
		return InviteResult{}, err
	}
	if err := pairLock(ctx, tx, fromID, toID); err != nil {
		return InviteResult{}, err
	}

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM play_invites WHERE from_user_id = $1 AND to_user_id = $2)`, fromID, toID).Scan(&exists); err != nil {
		return InviteResult{}, err
	}
	if !exists {
		var today int
		dayStart := profile.Today(now).Add(-4 * time.Hour) // полночь по Саратову (UTC+4) в UTC
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM play_invites WHERE from_user_id = $1 AND created_at >= $2`, fromID, dayStart).Scan(&today); err != nil {
			return InviteResult{}, err
		}
		if today >= DailyLimit {
			return InviteResult{}, &apperr.Error{Status: http.StatusTooManyRequests, Code: "invite_limit", Message: "На сегодня хватит, завтра ещё"}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO play_invites (from_user_id, to_user_id) VALUES ($1, $2)`, fromID, toID); err != nil {
			return InviteResult{}, err
		}
	}

	// Встречное предложение — совпадение, даже если вторая сторона раньше нажала «Не сейчас».
	var res InviteResult
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM play_invites WHERE from_user_id = $1 AND to_user_id = $2)`, toID, fromID).Scan(&res.Mutual); err != nil {
		return InviteResult{}, err
	}
	return res, tx.Commit(ctx)
}

// Withdraw отменяет своё предложение, пока нет взаимности.
// После взаимности отменить нельзя — это правило ещё согласуется (см. docs/roadmap.md).
func (s *Service) Withdraw(ctx context.Context, fromID, toID string) error {
	if !profile.IsUUID(toID) {
		return apperr.NotFound("Профиль не найден")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := pairLock(ctx, tx, fromID, toID); err != nil {
		return err
	}
	var mutual bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM play_invites WHERE from_user_id = $1 AND to_user_id = $2)`, toID, fromID).Scan(&mutual); err != nil {
		return err
	}
	if mutual {
		return apperr.Conflict("matched", "Вы уже хотите поиграть вместе — предложение не отменить")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM play_invites WHERE from_user_id = $1 AND to_user_id = $2`, fromID, toID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

type Relation struct {
	Invited   bool `json:"invited"`    // я предложил
	InvitedMe bool `json:"invited_me"` // мне предложили
	Mutual    bool `json:"mutual"`     // оба — хотим поиграть вместе
}

// Relation — для кнопки в профиле.
func (s *Service) Relation(ctx context.Context, userID, otherID string) (Relation, error) {
	var r Relation
	if !profile.IsUUID(otherID) {
		return r, nil
	}
	err := s.db.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM play_invites WHERE from_user_id = $1 AND to_user_id = $2),
		EXISTS (SELECT 1 FROM play_invites WHERE from_user_id = $2 AND to_user_id = $1)`, userID, otherID).Scan(&r.Invited, &r.InvitedMe)
	r.Mutual = r.Invited && r.InvitedMe
	return r, err
}

type Incoming struct {
	Author     profile.Author
	InvitedAt  time.Time
	PosterKey  string // превью последней записи
	VideoType  string
	VideoPeaks []byte
}

// Входящие: предложили мне, я не скрыл («Не сейчас») и ещё не ответил тем же.
const incomingWhere = `i.to_user_id = $1 AND i.dismissed_at IS NULL AND u.deleted_at IS NULL
	AND NOT EXISTS (SELECT 1 FROM play_invites back WHERE back.from_user_id = $1 AND back.to_user_id = i.from_user_id)`

// Incoming — «Хотят с тобой поиграть».
func (s *Service) Incoming(ctx context.Context, userID string, now time.Time) ([]Incoming, error) {
	rows, err := s.db.Query(ctx, `SELECT `+profile.AuthorSQL("u")+`, i.created_at,
			coalesce(v.poster_key, ''), coalesce(v.type, ''), coalesce(v.peaks, '[]')
		FROM play_invites i JOIN users u ON u.id = i.from_user_id
		LEFT JOIN LATERAL (SELECT poster_key, type, peaks FROM videos
			WHERE user_id = u.id AND status = 'ready' AND deleted_at IS NULL
			ORDER BY is_pinned DESC, created_at DESC LIMIT 1) v ON true
		WHERE `+incomingWhere+`
		ORDER BY i.created_at DESC LIMIT 200`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Incoming, error) {
		var in Incoming
		var a profile.AuthorScan
		err := r.Scan(append(a.Dest(), &in.InvitedAt, &in.PosterKey, &in.VideoType, &in.VideoPeaks)...)
		in.Author = a.Author(now)
		return in, err
	})
}

func (s *Service) IncomingCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRow(ctx, `SELECT count(*) FROM play_invites i JOIN users u ON u.id = i.from_user_id WHERE `+incomingWhere, userID).Scan(&n)
	return n, err
}

// Dismiss — «Не сейчас»: убирает из входящих, отправителю ничего не сообщается.
func (s *Service) Dismiss(ctx context.Context, userID, fromID string) error {
	if !profile.IsUUID(fromID) {
		return apperr.NotFound("Предложение не найдено")
	}
	_, err := s.db.Exec(ctx, `UPDATE play_invites SET dismissed_at = now() WHERE from_user_id = $1 AND to_user_id = $2 AND dismissed_at IS NULL`, fromID, userID)
	return err
}

type Match struct {
	Other     profile.Author
	CreatedAt time.Time // когда появилось второе предложение
}

// Matches — с кем взаимно: есть и моё предложение, и встречное.
func (s *Service) Matches(ctx context.Context, userID string, now time.Time) ([]Match, error) {
	rows, err := s.db.Query(ctx, `SELECT greatest(mine.created_at, back.created_at), `+profile.AuthorSQL("u")+`
		FROM play_invites mine
		JOIN play_invites back ON back.from_user_id = mine.to_user_id AND back.to_user_id = mine.from_user_id
		JOIN users u ON u.id = mine.to_user_id
		WHERE mine.from_user_id = $1 AND u.deleted_at IS NULL
		ORDER BY 1 DESC`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Match, error) {
		var m Match
		var a profile.AuthorScan
		err := r.Scan(append([]any{&m.CreatedAt}, a.Dest()...)...)
		m.Other = a.Author(now)
		return m, err
	})
}
