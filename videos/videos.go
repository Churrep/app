package videos

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"music/apperr"
	"music/media"
	"music/profile"
)

const (
	MaxDuration      = 60 * time.Second
	CoverMaxDuration = 30 * time.Second
	tolerance        = 1500 * time.Millisecond
)

type Video struct {
	ID         string
	UserID     string
	Type       string
	Tag        string
	Caption    string
	DurationMS int
	MediaKey   string
	PosterKey  string
	Peaks      []float64
	IsPinned   bool
	Status     string
	Error      string
	RecordedAt time.Time
	CreatedAt  time.Time
}

type Service struct {
	db *pgxpool.Pool
	m  *media.Media
}

func NewService(db *pgxpool.Pool, m *media.Media) *Service {
	return &Service{db: db, m: m}
}

const cols = `v.id::text, v.user_id::text, v.type, v.tag, v.caption, v.duration_ms, v.media_key, v.poster_key,
	v.peaks, v.is_pinned, v.status, v.error, v.recorded_at, v.created_at`

func scanDest(v *Video, peaks *[]byte) []any {
	return []any{&v.ID, &v.UserID, &v.Type, &v.Tag, &v.Caption, &v.DurationMS, &v.MediaKey, &v.PosterKey,
		peaks, &v.IsPinned, &v.Status, &v.Error, &v.RecordedAt, &v.CreatedAt}
}

type Input struct {
	Type       string
	Tag        string
	Caption    string
	RecordedAt time.Time
}

func (s *Service) Create(ctx context.Context, userID string, in Input, rawKey string, now time.Time) (Video, error) {
	if in.Type != "video" && in.Type != "audio" {
		return Video{}, apperr.Invalid("type", "Тип записи: video или audio")
	}
	if !profile.IsVideoTag(in.Tag) {
		return Video{}, apperr.Invalid("tag", "Выбери тег: своё, импровизация, упражнение или кавер")
	}
	in.Caption = strings.TrimSpace(in.Caption)
	if utf8.RuneCountInString(in.Caption) > 100 {
		return Video{}, apperr.Invalid("caption", "Подпись — до 100 символов")
	}

	if in.RecordedAt.IsZero() || in.RecordedAt.After(now.Add(time.Minute)) || now.Sub(in.RecordedAt) > 24*time.Hour {
		in.RecordedAt = now
	}

	var id string
	err := s.db.QueryRow(ctx, `INSERT INTO videos (id, user_id, type, tag, caption, raw_key, recorded_at)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING id::text`,
		userID, in.Type, in.Tag, in.Caption, rawKey, in.RecordedAt).Scan(&id)
	if err != nil {
		return Video{}, err
	}
	s.enqueue(id)
	return s.Get(ctx, id)
}

func (s *Service) enqueue(id string) {
	s.m.Queue.Add("video "+id, func(ctx context.Context) error { return s.process(ctx, id) })
}

func (s *Service) Resume(ctx context.Context) error {
	rows, err := s.db.Query(ctx, `SELECT id::text FROM videos WHERE status = 'processing' AND deleted_at IS NULL`)
	if err != nil {
		return err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return err
	}
	for _, id := range ids {
		s.enqueue(id)
	}
	return nil
}

func (s *Service) process(ctx context.Context, id string) error {
	var typ, tag, raw string
	err := s.db.QueryRow(ctx, `SELECT type, tag, raw_key FROM videos WHERE id = $1 AND status = 'processing'`, id).Scan(&typ, &tag, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	mediaKey, posterKey, peaks, dur, err := s.transcode(ctx, id, typ, tag, raw)
	if err != nil {
		s.m.Storage.Remove(mediaKey, posterKey)
		_, dbErr := s.db.Exec(ctx, `UPDATE videos SET status = 'failed', error = $2 WHERE id = $1`, id, media.ErrorText(err))
		return errors.Join(err, dbErr)
	}
	_, err = s.db.Exec(ctx, `UPDATE videos SET status = 'ready', media_key = $2, poster_key = $3, peaks = $4,
		duration_ms = $5, raw_key = '' WHERE id = $1`, id, mediaKey, posterKey, media.PeaksJSON(peaks), dur.Milliseconds())
	if err == nil {
		s.m.Storage.Remove(raw)
	}
	return err
}

func (s *Service) transcode(ctx context.Context, id, typ, tag, raw string) (mediaKey, posterKey string, peaks []float64, dur time.Duration, err error) {
	st := s.m.Storage
	in, err := st.Path(raw)
	if err != nil {
		return
	}
	if typ == "video" {
		mediaKey, posterKey = "videos/"+id+".mp4", "posters/"+id+".jpg"
	} else {
		mediaKey = "audio/" + id + ".m4a"
	}
	out, err := st.Prepare(mediaKey)
	if err != nil {
		return
	}
	if typ == "video" {
		err = s.m.FF.TranscodeVideo(ctx, in, out)
	} else {
		err = s.m.FF.TranscodeAudio(ctx, in, out, "160k", true)
	}
	if err != nil {
		return
	}
	if peaks, dur, err = s.m.FF.Peaks(ctx, out, 120); err != nil {
		err = &media.UserError{Message: "В записи нет звука. Проверь микрофон и запиши ещё раз"}
		return
	}
	limit := MaxDuration
	if tag == "cover" {
		limit = CoverMaxDuration
	}
	if dur > limit+tolerance {
		err = &media.UserError{Message: fmt.Sprintf("Запись длиннее %d секунд", int(limit.Seconds()))}
		return
	}
	if typ == "video" {
		var poster string
		if poster, err = st.Prepare(posterKey); err == nil {
			err = s.m.FF.Poster(ctx, out, poster)
		}
	}
	return
}

func (s *Service) Get(ctx context.Context, id string) (Video, error) {
	var v Video
	var peaks []byte
	err := s.db.QueryRow(ctx, `SELECT `+cols+` FROM videos v WHERE v.id = $1 AND v.deleted_at IS NULL`, id).Scan(scanDest(&v, &peaks)...)
	if errors.Is(err, pgx.ErrNoRows) {
		return Video{}, apperr.NotFound("Запись не найдена")
	}
	v.Peaks = media.ParsePeaks(peaks)
	return v, err
}

// ListByUser — записи человека: визитка первой. Свои — во всех статусах, чужие — только готовые.
func (s *Service) ListByUser(ctx context.Context, userID string, own bool) ([]Video, error) {
	rows, err := s.db.Query(ctx, `SELECT `+cols+` FROM videos v
		WHERE v.user_id = $1 AND v.deleted_at IS NULL AND ($2 OR v.status = 'ready')
		ORDER BY v.is_pinned DESC, v.created_at DESC LIMIT 200`, userID, own)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Video, error) {
		var v Video
		var peaks []byte
		err := r.Scan(scanDest(&v, &peaks)...)
		v.Peaks = media.ParsePeaks(peaks)
		return v, err
	})
}

// Update меняет подпись и/или делает запись визиткой.
func (s *Service) Update(ctx context.Context, userID, id string, caption *string, pinned *bool) (Video, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Video{}, err
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM videos WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, id, userID).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return Video{}, apperr.NotFound("Запись не найдена")
	}
	if err != nil {
		return Video{}, err
	}
	if caption != nil {
		c := strings.TrimSpace(*caption)
		if utf8.RuneCountInString(c) > 100 {
			return Video{}, apperr.Invalid("caption", "Подпись — до 100 символов")
		}
		if _, err := tx.Exec(ctx, `UPDATE videos SET caption = $2 WHERE id = $1`, id, c); err != nil {
			return Video{}, err
		}
	}
	if pinned != nil {
		if *pinned && status != "ready" {
			return Video{}, apperr.Conflict("not_ready", "Визиткой можно сделать только готовую запись")
		}
		if *pinned {
			if _, err := tx.Exec(ctx, `UPDATE videos SET is_pinned = false WHERE user_id = $1 AND is_pinned`, userID); err != nil {
				return Video{}, err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE videos SET is_pinned = $2 WHERE id = $1`, id, *pinned); err != nil {
			return Video{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Video{}, err
	}
	return s.Get(ctx, id)
}

func (s *Service) Delete(ctx context.Context, userID, id string) error {
	var raw, mediaKey, poster string
	err := s.db.QueryRow(ctx, `UPDATE videos SET deleted_at = now(), is_pinned = false
		WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
		RETURNING raw_key, media_key, poster_key`, id, userID).Scan(&raw, &mediaKey, &poster)
	if errors.Is(err, pgx.ErrNoRows) {
		return apperr.NotFound("Запись не найдена")
	}
	if err != nil {
		return err
	}
	s.m.Storage.Remove(raw, mediaKey, poster)
	return nil
}

type FeedFilter struct {
	Instrument string
	Genre      string
	LookingFor string
	LevelMin   int
	LevelMax   int
}

type FeedItem struct {
	Video  Video
	Author profile.Author
}

// Feed — свежие записи других музыкантов с фильтрами. Курсор — «created_at_unixnano_id» последней записи.
func (s *Service) Feed(ctx context.Context, viewerID string, f FeedFilter, cursor string, limit int, now time.Time) ([]FeedItem, string, error) {
	if f.LevelMin < 1 {
		f.LevelMin = 1
	}
	if f.LevelMax < 1 || f.LevelMax > 5 {
		f.LevelMax = 5
	}
	var curTime *time.Time
	var curID *string
	if cursor != "" {
		ts, id, ok := strings.Cut(cursor, "_")
		n, err := strconv.ParseInt(ts, 10, 64)
		if !ok || err != nil || len(id) != 36 {
			return nil, "", apperr.Invalid("cursor", "Неверный курсор")
		}
		t := time.Unix(0, n)
		curTime, curID = &t, &id
	}

	rows, err := s.db.Query(ctx, `SELECT `+cols+`, `+profile.AuthorSQL("u")+`
		FROM videos v JOIN users u ON u.id = v.user_id
		WHERE v.status = 'ready' AND v.deleted_at IS NULL AND u.deleted_at IS NULL AND u.level > 0
		  AND v.user_id <> $1
		  AND NOT EXISTS (SELECT 1 FROM likes lk WHERE lk.from_user_id = $1 AND lk.to_user_id = u.id)
		  AND ($2 = '' OR EXISTS (SELECT 1 FROM user_instruments ui WHERE ui.user_id = u.id AND ui.instrument_id = $2))
		  AND ($3 = '' OR EXISTS (SELECT 1 FROM user_genres ug WHERE ug.user_id = u.id AND ug.genre_id = $3))
		  AND ($4 = '' OR u.looking_for = $4)
		  AND u.level BETWEEN $5 AND $6
		  AND ($7::timestamptz IS NULL OR (v.created_at, v.id) < ($7, $8::uuid))
		ORDER BY v.created_at DESC, v.id DESC
		LIMIT $9`,
		viewerID, f.Instrument, f.Genre, f.LookingFor, f.LevelMin, f.LevelMax, curTime, curID, limit)
	if err != nil {
		return nil, "", err
	}
	items, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (FeedItem, error) {
		var it FeedItem
		var peaks []byte
		var a profile.AuthorScan
		err := r.Scan(append(scanDest(&it.Video, &peaks), a.Dest()...)...)
		it.Video.Peaks = media.ParsePeaks(peaks)
		it.Author = a.Author(now)
		return it, err
	})
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(items) == limit {
		last := items[len(items)-1].Video
		next = strconv.FormatInt(last.CreatedAt.UnixNano(), 10) + "_" + last.ID
	}
	return items, next, nil
}
