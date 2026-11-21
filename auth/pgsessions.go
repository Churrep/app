package auth

import (
	"context"
	"crypto/sha256"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// PostgresSessions — сессии в таблице sessions: переживают перезапуск и работают с несколькими копиями сервера.
type PostgresSessions struct {
	db *pgxpool.Pool
}

func NewPostgresSessions(db *pgxpool.Pool) *PostgresSessions {
	return &PostgresSessions{db: db}
}

func (s *PostgresSessions) Create(ctx context.Context, userID string) (string, time.Time, error) {
	token, key, err := newToken()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := time.Now().Add(SessionTTL)
	if _, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE expires_at < now()`); err != nil {
		return "", time.Time{}, err
	}
	if _, err := s.db.Exec(ctx, `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
		key[:], userID, expires); err != nil {
		return "", time.Time{}, err
	}
	return token, expires, nil
}

func (s *PostgresSessions) Lookup(ctx context.Context, token string) (string, bool, error) {
	key := sha256.Sum256([]byte(token))
	var userID string
	err := s.db.QueryRow(ctx, `SELECT user_id::text FROM sessions WHERE token_hash = $1 AND expires_at > now()`, key[:]).Scan(&userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return userID, true, nil
}

func (s *PostgresSessions) Delete(ctx context.Context, token string) error {
	key := sha256.Sum256([]byte(token))
	_, err := s.db.Exec(ctx, `DELETE FROM sessions WHERE token_hash = $1`, key[:])
	return err
}
