package profile

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct {
	db *pgxpool.Pool
}

func NewPostgresStore(db *pgxpool.Pool) *PostgresStore {
	return &PostgresStore{db: db}
}

// querier — общее у пула и транзакции.
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

const selectUser = `SELECT id::text, coalesce(phone, ''), coalesce(telegram_id, 0), telegram_username, name,
	birth_date, district, photo_url, level, goals, looking_for, looking_for_instrument,
	show_age, show_district, theme, consent_at, created_at, updated_at
	FROM users`

func (s *PostgresStore) Get(ctx context.Context, id string) (User, error) {
	if !isUUID(id) {
		return User{}, ErrNotFound
	}
	return loadUser(ctx, s.db, selectUser+` WHERE id = $1 AND deleted_at IS NULL`, id)
}

func (s *PostgresStore) GetOrCreateByPhone(ctx context.Context, phone string, now time.Time) (User, bool, error) {
	var id string
	err := s.db.QueryRow(ctx, `INSERT INTO users (id, phone, created_at, updated_at) VALUES ($1, $2, $3, $3)
		ON CONFLICT (phone) WHERE deleted_at IS NULL DO NOTHING
		RETURNING id::text`, newID(), phone, now).Scan(&id)
	created := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return User{}, false, err
	}
	u, err := loadUser(ctx, s.db, selectUser+` WHERE phone = $1 AND deleted_at IS NULL`, phone)
	return u, created, err
}

func (s *PostgresStore) GetOrCreateByTelegram(ctx context.Context, tg TelegramProfile, now time.Time) (User, bool, error) {
	var id string
	err := s.db.QueryRow(ctx, `INSERT INTO users (id, telegram_id, telegram_username, name, photo_url, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $6)
		ON CONFLICT (telegram_id) WHERE deleted_at IS NULL DO NOTHING
		RETURNING id::text`, newID(), tg.ID, tg.Username, tg.Name, tg.PhotoURL, now).Scan(&id)
	created := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return User{}, false, err
	}
	u, err := loadUser(ctx, s.db, selectUser+` WHERE telegram_id = $1 AND deleted_at IS NULL`, tg.ID)
	return u, created, err
}

func (s *PostgresStore) Update(ctx context.Context, id string, fn func(*User) error) (User, error) {
	if !isUUID(id) {
		return User{}, ErrNotFound
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback(ctx)

	u, err := loadUser(ctx, tx, selectUser+` WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, id)
	if err != nil {
		return User{}, err
	}
	if err := fn(&u); err != nil {
		return User{}, err
	}
	u.UpdatedAt = time.Now().UTC()

	var birth *time.Time
	if !u.BirthDate.IsZero() {
		birth = &u.BirthDate
	}
	if _, err := tx.Exec(ctx, `UPDATE users SET name = $2, birth_date = $3, district = $4, photo_url = $5,
		level = $6, goals = $7, looking_for = $8, looking_for_instrument = $9, show_age = $10, show_district = $11,
		theme = $12, consent_at = $13, updated_at = $14 WHERE id = $1`,
		u.ID, u.Name, birth, u.District, u.PhotoURL, u.Level, orEmpty(u.Goals), u.LookingFor,
		u.LookingForInstrument, u.ShowAge, u.ShowDistrict, u.Theme, u.ConsentAt, u.UpdatedAt); err != nil {
		return User{}, err
	}

	if _, err := tx.Exec(ctx, `DELETE FROM user_instruments WHERE user_id = $1`, u.ID); err != nil {
		return User{}, err
	}
	for i, in := range u.Instruments {
		if _, err := tx.Exec(ctx, `INSERT INTO user_instruments (user_id, instrument_id, is_main, position) VALUES ($1, $2, $3, $4)`,
			u.ID, in.ID, in.IsMain, i); err != nil {
			return User{}, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM user_genres WHERE user_id = $1`, u.ID); err != nil {
		return User{}, err
	}
	for i, g := range u.Genres {
		if _, err := tx.Exec(ctx, `INSERT INTO user_genres (user_id, genre_id, position) VALUES ($1, $2, $3)`, u.ID, g, i); err != nil {
			return User{}, err
		}
	}
	return u, tx.Commit(ctx)
}

func loadUser(ctx context.Context, q querier, sql string, arg any) (User, error) {
	var u User
	var birth *time.Time
	err := q.QueryRow(ctx, sql, arg).Scan(&u.ID, &u.Phone, &u.TelegramID, &u.TelegramUsername, &u.Name,
		&birth, &u.District, &u.PhotoURL, &u.Level, &u.Goals, &u.LookingFor, &u.LookingForInstrument,
		&u.ShowAge, &u.ShowDistrict, &u.Theme, &u.ConsentAt, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	if birth != nil {
		u.BirthDate = birth.UTC()
	}

	rows, err := q.Query(ctx, `SELECT instrument_id, is_main FROM user_instruments WHERE user_id = $1 ORDER BY position`, u.ID)
	if err != nil {
		return User{}, err
	}
	u.Instruments, err = pgx.CollectRows(rows, func(r pgx.CollectableRow) (Instrument, error) {
		var in Instrument
		return in, r.Scan(&in.ID, &in.IsMain)
	})
	if err != nil {
		return User{}, err
	}

	rows, err = q.Query(ctx, `SELECT genre_id FROM user_genres WHERE user_id = $1 ORDER BY position`, u.ID)
	if err != nil {
		return User{}, err
	}
	u.Genres, err = pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return User{}, err
	}
	return u, nil
}
