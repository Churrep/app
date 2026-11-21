// Package venues — репетиционные точки Саратова для карты.
package venues

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"music/apperr"
	"music/profile"
)

// Hours — часы работы по дням: {"mon": ["10:00-23:00"], "sat": ["12:00-02:00"]}.
// Конец раньше начала — значит работают после полуночи.
type Hours map[string][]string

type Venue struct {
	ID           string
	Name         string
	Type         string
	Address      string
	Lat          float64
	Lon          float64
	District     string
	PriceMin     *int
	PriceMax     *int
	OpeningHours Hours
	RoomsCount   *int
	Equipment    []string
	Phones       []string
	Telegram     string
	Website      string
	Photos       []string
	VerifiedAt   *time.Time
}

type Store struct {
	db *pgxpool.Pool
}

func NewStore(db *pgxpool.Pool) *Store { return &Store{db: db} }

const cols = `id::text, name, type, address, ST_Y(location::geometry), ST_X(location::geometry), district,
	price_per_hour_min, price_per_hour_max, opening_hours, rooms_count, equipment, phones, telegram, website, photos, verified_at`

func scan(r pgx.Row) (Venue, error) {
	var v Venue
	var hours []byte
	var rooms *int16
	err := r.Scan(&v.ID, &v.Name, &v.Type, &v.Address, &v.Lat, &v.Lon, &v.District, &v.PriceMin, &v.PriceMax,
		&hours, &rooms, &v.Equipment, &v.Phones, &v.Telegram, &v.Website, &v.Photos, &v.VerifiedAt)
	if err != nil {
		return v, err
	}
	if rooms != nil {
		n := int(*rooms)
		v.RoomsCount = &n
	}
	if json.Unmarshal(hours, &v.OpeningHours) != nil || v.OpeningHours == nil {
		v.OpeningHours = Hours{}
	}
	return v, nil
}

type Filter struct {
	Types       []string
	PriceMin    int // точка подходит, если её максимальная цена не ниже
	PriceMax    int // и минимальная — не выше
	HasDrums    bool
	HasBackline bool
	OpenNow     bool
	BBox        []float64 // minLon, minLat, maxLon, maxLat
}

func (s *Store) List(ctx context.Context, f Filter, now time.Time) ([]Venue, error) {
	var types []string
	if len(f.Types) > 0 {
		types = f.Types
	}
	var bbox []float64
	if len(f.BBox) == 4 {
		bbox = f.BBox
	}
	rows, err := s.db.Query(ctx, `SELECT `+cols+` FROM venues
		WHERE status = 'published'
		  AND ($1::text[] IS NULL OR type = ANY($1))
		  AND ($2 = 0 OR coalesce(price_per_hour_max, price_per_hour_min, 0) >= $2)
		  AND ($3 = 0 OR coalesce(price_per_hour_min, 0) <= $3)
		  AND (NOT $4 OR 'drums' = ANY(equipment))
		  AND (NOT $5 OR equipment && ARRAY['bass_amp', 'guitar_amp'])
		  AND ($6::float8[] IS NULL OR ST_Intersects(location, ST_MakeEnvelope($6[1], $6[2], $6[3], $6[4], 4326)::geography))
		ORDER BY name`, types, f.PriceMin, f.PriceMax, f.HasDrums, f.HasBackline, bbox)
	if err != nil {
		return nil, err
	}
	list, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (Venue, error) { return scan(r) })
	if err != nil || !f.OpenNow {
		return list, err
	}
	open := list[:0]
	for _, v := range list {
		if o, known := v.OpeningHours.OpenAt(now); known && o {
			open = append(open, v)
		}
	}
	return open, nil
}

func (s *Store) Get(ctx context.Context, id string) (Venue, error) {
	if !profile.IsUUID(id) {
		return Venue{}, apperr.NotFound("Точка не найдена")
	}
	v, err := scan(s.db.QueryRow(ctx, `SELECT `+cols+` FROM venues WHERE id = $1 AND status = 'published'`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Venue{}, apperr.NotFound("Точка не найдена")
	}
	return v, err
}

// Feedback — «Предложить точку» (kind=suggest) или «Сообщить об ошибке» (kind=error). Уходит на модерацию.
func (s *Store) Feedback(ctx context.Context, userID, kind, venueID, name, address, message string) error {
	name, address, message = strings.TrimSpace(name), strings.TrimSpace(address), strings.TrimSpace(message)
	if utf8.RuneCountInString(message) > 1000 || utf8.RuneCountInString(name) > 100 || utf8.RuneCountInString(address) > 200 {
		return apperr.Invalid("message", "Слишком длинный текст")
	}
	var venue *string
	switch kind {
	case "suggest":
		if name == "" || address == "" {
			return apperr.Invalid("name", "Напиши название и адрес")
		}
	case "error":
		if message == "" {
			return apperr.Invalid("message", "Напиши, что не так")
		}
		if _, err := s.Get(ctx, venueID); err != nil {
			return err
		}
		venue = &venueID
	default:
		return apperr.Invalid("kind", "kind: suggest или error")
	}
	_, err := s.db.Exec(ctx, `INSERT INTO venue_feedback (id, kind, venue_id, user_id, name, address, message)
		VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`, kind, venue, userID, name, address, message)
	return err
}

var days = []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

// OpenAt — открыто ли в момент t по времени Саратова. known=false, если часы не указаны.
func (h Hours) OpenAt(t time.Time) (open, known bool) {
	if len(h) == 0 {
		return false, false
	}
	t = t.In(profile.Saratov)
	now := t.Hour()*60 + t.Minute()
	today, yesterday := days[t.Weekday()], days[(t.Weekday()+6)%7]
	for _, iv := range h[today] {
		from, to, ok := parseInterval(iv)
		if !ok {
			continue
		}
		if to > from && now >= from && now < to || to <= from && now >= from {
			return true, true
		}
	}
	for _, iv := range h[yesterday] {
		from, to, ok := parseInterval(iv)
		if ok && to <= from && now < to {
			return true, true
		}
	}
	return false, true
}

func parseInterval(s string) (from, to int, ok bool) {
	a, b, found := strings.Cut(s, "-")
	if !found {
		return 0, 0, false
	}
	from, ok1 := parseHM(a)
	to, ok2 := parseHM(b)
	return from, to, ok1 && ok2
}

func parseHM(s string) (int, bool) {
	t, err := time.Parse("15:04", strings.TrimSpace(s))
	if err != nil {
		if strings.TrimSpace(s) == "24:00" {
			return 24 * 60, true
		}
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}
