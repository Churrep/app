// Package tracks — группы и «недостающая дорожка»: места в группах, минусы и отклики с записью партии.
package tracks

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"music/apperr"
	"music/media"
	"music/profile"
)

const MaxBackingDuration = 5 * time.Minute

type Service struct {
	db *pgxpool.Pool
	m  *media.Media
}

func NewService(db *pgxpool.Pool, m *media.Media) *Service {
	return &Service{db: db, m: m}
}

// ---------- Группы ----------

type Band struct {
	ID     string
	Name   string
	Genres []string
	Role   string
}

func (s *Service) CreateBand(ctx context.Context, userID, name string, genres []string) (Band, error) {
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n == 0 || n > 60 {
		return Band{}, apperr.Invalid("name", "Название группы — от 1 до 60 символов")
	}
	if len(genres) > profile.MaxGenres {
		return Band{}, apperr.Invalid("genres", "До 5 жанров")
	}
	for _, g := range genres {
		if !profile.IsGenre(g) {
			return Band{}, apperr.Invalid("genres", "Проверь жанры")
		}
	}
	if genres == nil {
		genres = []string{}
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Band{}, err
	}
	defer tx.Rollback(ctx)
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO bands (id, name, genre_ids, created_by) VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id::text`,
		name, genres, userID).Scan(&id); err != nil {
		return Band{}, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO band_members (band_id, user_id, role) VALUES ($1, $2, 'admin')`, id, userID); err != nil {
		return Band{}, err
	}
	return Band{ID: id, Name: name, Genres: genres, Role: "admin"}, tx.Commit(ctx)
}

func (s *Service) MyBands(ctx context.Context, userID string) ([]Band, error) {
	rows, err := s.db.Query(ctx, `SELECT b.id::text, b.name, b.genre_ids, m.role FROM bands b
		JOIN band_members m ON m.band_id = b.id WHERE m.user_id = $1 ORDER BY b.created_at`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Band, error) {
		var b Band
		return b, r.Scan(&b.ID, &b.Name, &b.Genres, &b.Role)
	})
}

type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

func isMember(ctx context.Context, q querier, bandID, userID string) (bool, error) {
	var ok bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM band_members WHERE band_id = $1 AND user_id = $2)`, bandID, userID).Scan(&ok)
	return ok, err
}

// ---------- Места ----------

type Spot struct {
	ID                string
	BandID            string
	BandName          string
	InstrumentID      string
	SongTitle         string
	BackingKey        string
	BackingPeaks      []float64
	BackingDurationMS int
	BPM               int
	Key               string
	GenreID           string
	Description       string
	Deadline          *time.Time
	Status            string
	Error             string
	CreatedAt         time.Time
	ResponsesCount    int
	IsMember          bool
	MyResponseID      string
	MyResponseStatus  string
}

// Статус места для интерфейса: срок вышел — тоже «закрыто».
func (sp Spot) Expired(now time.Time) bool {
	return sp.Deadline != nil && sp.Deadline.Before(profile.Today(now))
}

const spotCols = `s.id::text, s.band_id::text, b.name, s.instrument_id, s.song_title, s.backing_key, s.backing_peaks,
	s.backing_duration_ms, s.bpm, s.key, s.genre_id, s.description, s.deadline, s.status, s.error, s.created_at,
	(SELECT count(*) FROM spot_responses r WHERE r.spot_id = s.id AND r.status IN ('sent', 'invited', 'rejected')),
	EXISTS (SELECT 1 FROM band_members m WHERE m.band_id = s.band_id AND m.user_id = $1),
	coalesce((SELECT r.id::text FROM spot_responses r WHERE r.spot_id = s.id AND r.user_id = $1), ''),
	coalesce((SELECT r.status FROM spot_responses r WHERE r.spot_id = s.id AND r.user_id = $1), '')`

func scanSpot(r pgx.Row) (Spot, error) {
	var sp Spot
	var peaks []byte
	err := r.Scan(&sp.ID, &sp.BandID, &sp.BandName, &sp.InstrumentID, &sp.SongTitle, &sp.BackingKey, &peaks,
		&sp.BackingDurationMS, &sp.BPM, &sp.Key, &sp.GenreID, &sp.Description, &sp.Deadline, &sp.Status, &sp.Error,
		&sp.CreatedAt, &sp.ResponsesCount, &sp.IsMember, &sp.MyResponseID, &sp.MyResponseStatus)
	sp.BackingPeaks = media.ParsePeaks(peaks)
	return sp, err
}

func collectSpots(rows pgx.Rows) ([]Spot, error) {
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (Spot, error) { return scanSpot(r) })
}

type SpotInput struct {
	BandID       string
	InstrumentID string
	SongTitle    string
	BPM          int
	Key          string
	GenreID      string
	Description  string
	Deadline     string // ГГГГ-ММ-ДД, можно пусто
	OwnSong      bool
}

func (s *Service) CreateSpot(ctx context.Context, userID string, in SpotInput, rawKey string, now time.Time) (Spot, error) {
	in.SongTitle = strings.TrimSpace(in.SongTitle)
	in.Key = strings.TrimSpace(in.Key)
	in.Description = strings.TrimSpace(in.Description)
	switch {
	case !in.OwnSong:
		return Spot{}, apperr.Invalid("own_song", "Каверы нельзя: нужна ваша собственная песня")
	case !profile.IsInstrument(in.InstrumentID):
		return Spot{}, apperr.Invalid("instrument_id", "Выбери, какой инструмент нужен")
	case !profile.IsGenre(in.GenreID):
		return Spot{}, apperr.Invalid("genre_id", "Выбери жанр")
	case in.BPM < 30 || in.BPM > 300:
		return Spot{}, apperr.Invalid("bpm", "Темп — от 30 до 300 BPM")
	case utf8.RuneCountInString(in.SongTitle) > 80:
		return Spot{}, apperr.Invalid("song_title", "Название песни — до 80 символов")
	case utf8.RuneCountInString(in.Key) > 8:
		return Spot{}, apperr.Invalid("key", "Тональность — коротко, например Am или F#")
	case utf8.RuneCountInString(in.Description) > 300:
		return Spot{}, apperr.Invalid("description", "Текст — до 300 символов")
	}
	var deadline *time.Time
	if in.Deadline != "" {
		d, err := time.Parse(time.DateOnly, in.Deadline)
		today := profile.Today(now)
		if err != nil || d.Before(today) || d.After(today.AddDate(0, 6, 0)) {
			return Spot{}, apperr.Invalid("deadline", "Срок — от сегодня до полугода вперёд")
		}
		deadline = &d
	}

	member, err := isMember(ctx, s.db, in.BandID, userID)
	if err != nil {
		return Spot{}, err
	}
	if !member {
		return Spot{}, apperr.Forbidden("Места создают только участники группы")
	}

	var id string
	err = s.db.QueryRow(ctx, `INSERT INTO open_spots (id, band_id, instrument_id, song_title, raw_key, bpm, key, genre_id,
		description, deadline, own_song_confirmed, created_by)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10) RETURNING id::text`,
		in.BandID, in.InstrumentID, in.SongTitle, rawKey, in.BPM, in.Key, in.GenreID, in.Description, deadline, userID).Scan(&id)
	if err != nil {
		return Spot{}, err
	}
	s.enqueueSpot(id)
	return s.GetSpot(ctx, userID, id)
}

func (s *Service) enqueueSpot(id string) {
	s.m.Queue.Add("spot "+id, func(ctx context.Context) error { return s.processBacking(ctx, id) })
}

func (s *Service) processBacking(ctx context.Context, id string) error {
	var raw string
	err := s.db.QueryRow(ctx, `SELECT raw_key FROM open_spots WHERE id = $1 AND status = 'processing'`, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	key := "backing/" + id + ".m4a"
	peaks, dur, err := s.convertAudio(ctx, raw, key, "192k", 400)
	if err == nil && dur > MaxBackingDuration+time.Second {
		err = &media.UserError{Message: "Минус длиннее 5 минут"}
	}
	if err != nil {
		s.m.Storage.Remove(key)
		_, dbErr := s.db.Exec(ctx, `UPDATE open_spots SET status = 'failed', error = $2 WHERE id = $1`, id, media.ErrorText(err))
		return errors.Join(err, dbErr)
	}
	_, err = s.db.Exec(ctx, `UPDATE open_spots SET status = 'open', backing_key = $2, backing_peaks = $3,
		backing_duration_ms = $4, raw_key = '' WHERE id = $1`, id, key, media.PeaksJSON(peaks), dur.Milliseconds())
	if err == nil {
		s.m.Storage.Remove(raw)
	}
	return err
}

func (s *Service) convertAudio(ctx context.Context, rawKey, outKey, bitrate string, bins int) ([]float64, time.Duration, error) {
	in, err := s.m.Storage.Path(rawKey)
	if err != nil {
		return nil, 0, err
	}
	out, err := s.m.Storage.Prepare(outKey)
	if err != nil {
		return nil, 0, err
	}
	if err := s.m.FF.TranscodeAudio(ctx, in, out, bitrate, false); err != nil {
		return nil, 0, err
	}
	return s.m.FF.Peaks(ctx, out, bins)
}

// ListOpen — открытые места других групп. Сначала те, что под инструменты человека (mine),
// only — показать только места под этот инструмент.
func (s *Service) ListOpen(ctx context.Context, userID string, mine []string, only string, now time.Time) ([]Spot, error) {
	rows, err := s.db.Query(ctx, `SELECT `+spotCols+` FROM open_spots s JOIN bands b ON b.id = s.band_id
		WHERE s.status = 'open' AND (s.deadline IS NULL OR s.deadline >= $2)
		  AND ($4 = '' OR s.instrument_id = $4)
		  AND NOT EXISTS (SELECT 1 FROM band_members m WHERE m.band_id = s.band_id AND m.user_id = $1)
		ORDER BY (s.instrument_id = ANY($3)) DESC, s.created_at DESC LIMIT 200`, userID, profile.Today(now), mine, only)
	if err != nil {
		return nil, err
	}
	return collectSpots(rows)
}

// MySpots — места групп, где человек участник.
func (s *Service) MySpots(ctx context.Context, userID string) ([]Spot, error) {
	rows, err := s.db.Query(ctx, `SELECT `+spotCols+` FROM open_spots s JOIN bands b ON b.id = s.band_id
		WHERE EXISTS (SELECT 1 FROM band_members m WHERE m.band_id = s.band_id AND m.user_id = $1)
		ORDER BY s.created_at DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	return collectSpots(rows)
}

func (s *Service) GetSpot(ctx context.Context, userID, id string) (Spot, error) {
	if !profile.IsUUID(id) {
		return Spot{}, apperr.NotFound("Место не найдено")
	}
	sp, err := scanSpot(s.db.QueryRow(ctx, `SELECT `+spotCols+` FROM open_spots s JOIN bands b ON b.id = s.band_id WHERE s.id = $2`, userID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Spot{}, apperr.NotFound("Место не найдено")
	}
	return sp, err
}

func (s *Service) CloseSpot(ctx context.Context, userID, id string) (Spot, error) {
	sp, err := s.GetSpot(ctx, userID, id)
	if err != nil {
		return Spot{}, err
	}
	if !sp.IsMember {
		return Spot{}, apperr.Forbidden("Закрыть место может только участник группы")
	}
	if _, err := s.db.Exec(ctx, `UPDATE open_spots SET status = 'closed' WHERE id = $1 AND status IN ('open', 'failed')`, id); err != nil {
		return Spot{}, err
	}
	return s.GetSpot(ctx, userID, id)
}

// ---------- Отклики ----------

type Response struct {
	ID              string
	SpotID          string
	UserID          string
	TrackKey        string
	TrackPeaks      []float64
	TrackDurationMS int
	OffsetMS        int
	StartMS         int
	GainBacking     float64
	GainTrack       float64
	MixKey          string
	Status          string
	Error           string
	CreatedAt       time.Time
	Author          profile.Author // для группы
	Spot            *Spot          // для «Мои отклики»
}

const respCols = `r.id::text, r.spot_id::text, r.user_id::text, r.track_key, r.track_peaks, r.track_duration_ms,
	r.offset_ms, r.start_ms, r.gain_backing, r.gain_track, r.mix_key, r.status, r.error, r.created_at`

func respDest(r *Response, peaks *[]byte) []any {
	return []any{&r.ID, &r.SpotID, &r.UserID, &r.TrackKey, peaks, &r.TrackDurationMS, &r.OffsetMS, &r.StartMS,
		&r.GainBacking, &r.GainTrack, &r.MixKey, &r.Status, &r.Error, &r.CreatedAt}
}

type ResponseInput struct {
	OffsetMS    int
	StartMS     int
	GainBacking float64
	GainTrack   float64
}

func (s *Service) CreateResponse(ctx context.Context, userID, spotID string, in ResponseInput, rawKey string, now time.Time) (Response, error) {
	if in.OffsetMS < -300 || in.OffsetMS > 300 {
		return Response{}, apperr.Invalid("offset_ms", "Сдвиг — от −300 до 300 мс")
	}
	if in.GainBacking < 0 || in.GainBacking > 2 || in.GainTrack < 0 || in.GainTrack > 2 {
		return Response{}, apperr.Invalid("gain", "Громкость — от 0 до 2")
	}
	sp, err := s.GetSpot(ctx, userID, spotID)
	if err != nil {
		return Response{}, err
	}
	switch {
	case sp.IsMember:
		return Response{}, apperr.Forbidden("Это место твоей группы")
	case sp.Status != "open":
		return Response{}, apperr.Conflict("spot_closed", "Место уже закрыто")
	case sp.Expired(now):
		return Response{}, apperr.Conflict("spot_expired", "Срок приёма откликов вышел")
	case in.StartMS < 0 || in.StartMS >= sp.BackingDurationMS:
		return Response{}, apperr.Invalid("start_ms", "Начало фрагмента за пределами песни")
	}

	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Response{}, err
	}
	defer tx.Rollback(ctx)

	var id, status, oldRaw, oldTrack, oldMix string
	err = tx.QueryRow(ctx, `SELECT id::text, status, raw_key, track_key, mix_key FROM spot_responses
		WHERE spot_id = $1 AND user_id = $2 FOR UPDATE`, spotID, userID).Scan(&id, &status, &oldRaw, &oldTrack, &oldMix)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		err = tx.QueryRow(ctx, `INSERT INTO spot_responses (id, spot_id, user_id, raw_key, offset_ms, start_ms, gain_backing, gain_track)
			VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7) RETURNING id::text`,
			spotID, userID, rawKey, in.OffsetMS, in.StartMS, in.GainBacking, in.GainTrack).Scan(&id)
	case err != nil:
	case status == "invited" || status == "rejected":
		return Response{}, apperr.Conflict("already_answered", "Группа уже ответила на твой отклик")
	default:
		// Перезапись: старые файлы удаляем после коммита.
		_, err = tx.Exec(ctx, `UPDATE spot_responses SET raw_key = $2, track_key = '', mix_key = '', track_peaks = '[]',
			track_duration_ms = 0, offset_ms = $3, start_ms = $4, gain_backing = $5, gain_track = $6,
			status = 'processing', error = '', created_at = now(), updated_at = now() WHERE id = $1`,
			id, rawKey, in.OffsetMS, in.StartMS, in.GainBacking, in.GainTrack)
	}
	if err != nil {
		return Response{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Response{}, err
	}
	s.m.Storage.Remove(oldRaw, oldTrack, oldMix)
	s.enqueueResponse(id)
	return s.getResponse(ctx, id)
}

func (s *Service) enqueueResponse(id string) {
	s.m.Queue.Add("response "+id, func(ctx context.Context) error { return s.processResponse(ctx, id) })
}

func (s *Service) processResponse(ctx context.Context, id string) error {
	var raw, backingKey string
	var backingMS int
	var p media.MixParams
	err := s.db.QueryRow(ctx, `SELECT r.raw_key, s.backing_key, s.backing_duration_ms, r.start_ms, r.offset_ms, r.gain_backing, r.gain_track
		FROM spot_responses r JOIN open_spots s ON s.id = r.spot_id WHERE r.id = $1 AND r.status = 'processing'`, id).
		Scan(&raw, &backingKey, &backingMS, &p.StartMS, &p.OffsetMS, &p.GainBacking, &p.GainTrack)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	// Новый ключ на каждую версию, чтобы браузер не играл старую из кеша.
	trackKey, mixKey := media.NewKey("tracks", ".m4a"), media.NewKey("mixes", ".m4a")
	peaks, dur, err := s.convertAudio(ctx, raw, trackKey, "160k", 200)
	switch {
	case err != nil:
	case dur < time.Second:
		err = &media.UserError{Message: "Слишком короткая запись"}
	case p.StartMS+int(dur.Milliseconds()) > backingMS+2000:
		err = &media.UserError{Message: "Запись длиннее минуса"}
	default:
		p.Duration = dur
		var backing, track, mix string
		if backing, err = s.m.Storage.Path(backingKey); err == nil {
			track, _ = s.m.Storage.Path(trackKey)
			if mix, err = s.m.Storage.Prepare(mixKey); err == nil {
				err = s.m.FF.Mix(ctx, backing, track, mix, p)
			}
		}
	}
	if err != nil {
		s.m.Storage.Remove(trackKey, mixKey)
		_, dbErr := s.db.Exec(ctx, `UPDATE spot_responses SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, id, media.ErrorText(err))
		return errors.Join(err, dbErr)
	}
	_, err = s.db.Exec(ctx, `UPDATE spot_responses SET status = 'sent', track_key = $2, mix_key = $3, track_peaks = $4,
		track_duration_ms = $5, raw_key = '', updated_at = now() WHERE id = $1 AND status = 'processing'`,
		id, trackKey, mixKey, media.PeaksJSON(peaks), dur.Milliseconds())
	if err == nil {
		s.m.Storage.Remove(raw)
	}
	return err
}

// Resume ставит в очередь минусы и отклики, не обработанные до перезапуска.
func (s *Service) Resume(ctx context.Context) error {
	for _, q := range []struct {
		sql string
		add func(string)
	}{
		{`SELECT id::text FROM open_spots WHERE status = 'processing'`, s.enqueueSpot},
		{`SELECT id::text FROM spot_responses WHERE status = 'processing'`, s.enqueueResponse},
	} {
		rows, err := s.db.Query(ctx, q.sql)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		for _, id := range ids {
			q.add(id)
		}
	}
	return nil
}

func (s *Service) getResponse(ctx context.Context, id string) (Response, error) {
	var r Response
	var peaks []byte
	err := s.db.QueryRow(ctx, `SELECT `+respCols+` FROM spot_responses r WHERE r.id = $1`, id).Scan(respDest(&r, &peaks)...)
	r.TrackPeaks = media.ParsePeaks(peaks)
	return r, err
}

// ListResponses — отклики на место; видят только участники группы. Обрабатываемые и сломанные не показываем.
func (s *Service) ListResponses(ctx context.Context, userID, spotID string, now time.Time) ([]Response, error) {
	sp, err := s.GetSpot(ctx, userID, spotID)
	if err != nil {
		return nil, err
	}
	if !sp.IsMember {
		return nil, apperr.Forbidden("Отклики видят только участники группы")
	}
	rows, err := s.db.Query(ctx, `SELECT `+respCols+`, `+profile.AuthorSQL("u")+`
		FROM spot_responses r JOIN users u ON u.id = r.user_id
		WHERE r.spot_id = $1 AND r.status IN ('sent', 'invited', 'rejected') AND u.deleted_at IS NULL
		ORDER BY r.created_at`, spotID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Response, error) {
		var r Response
		var peaks []byte
		var a profile.AuthorScan
		err := row.Scan(append(respDest(&r, &peaks), a.Dest()...)...)
		r.TrackPeaks = media.ParsePeaks(peaks)
		r.Author = a.Author(now)
		return r, err
	})
}

// SetResponseStatus — «Позвать на встречу» (invited) или «Не подходит» (rejected).
func (s *Service) SetResponseStatus(ctx context.Context, userID, id, status string) (Response, error) {
	if status != "invited" && status != "rejected" {
		return Response{}, apperr.Invalid("status", "Статус: invited или rejected")
	}
	if !profile.IsUUID(id) {
		return Response{}, apperr.NotFound("Отклик не найден")
	}
	var bandID, cur string
	err := s.db.QueryRow(ctx, `SELECT s.band_id::text, r.status FROM spot_responses r JOIN open_spots s ON s.id = r.spot_id
		WHERE r.id = $1`, id).Scan(&bandID, &cur)
	if errors.Is(err, pgx.ErrNoRows) {
		return Response{}, apperr.NotFound("Отклик не найден")
	}
	if err != nil {
		return Response{}, err
	}
	member, err := isMember(ctx, s.db, bandID, userID)
	if err != nil {
		return Response{}, err
	}
	if !member {
		return Response{}, apperr.Forbidden("Отвечать на отклики может только участник группы")
	}
	if cur != "sent" {
		return Response{}, apperr.Conflict("already_answered", "На этот отклик уже ответили")
	}
	if _, err := s.db.Exec(ctx, `UPDATE spot_responses SET status = $2, updated_at = now() WHERE id = $1 AND status = 'sent'`, id, status); err != nil {
		return Response{}, err
	}
	return s.getResponse(ctx, id)
}

// MyResponses — отклики человека вместе с местами.
func (s *Service) MyResponses(ctx context.Context, userID string) ([]Response, error) {
	rows, err := s.db.Query(ctx, `SELECT `+respCols+`, `+spotCols+`
		FROM spot_responses r JOIN open_spots s ON s.id = r.spot_id JOIN bands b ON b.id = s.band_id
		WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (Response, error) {
		var r Response
		var peaks, spotPeaks []byte
		var sp Spot
		dest := append(respDest(&r, &peaks), &sp.ID, &sp.BandID, &sp.BandName, &sp.InstrumentID, &sp.SongTitle, &sp.BackingKey, &spotPeaks,
			&sp.BackingDurationMS, &sp.BPM, &sp.Key, &sp.GenreID, &sp.Description, &sp.Deadline, &sp.Status, &sp.Error,
			&sp.CreatedAt, &sp.ResponsesCount, &sp.IsMember, &sp.MyResponseID, &sp.MyResponseStatus)
		err := row.Scan(dest...)
		r.TrackPeaks = media.ParsePeaks(peaks)
		sp.BackingPeaks = media.ParsePeaks(spotPeaks)
		r.Spot = &sp
		return r, err
	})
}
