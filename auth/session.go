package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"sync"
	"time"
)

const SessionTTL = 30 * 24 * time.Hour

// SessionStore хранит сессии. Храним только хэш токена: утечка хранилища не даёт войти.
type SessionStore interface {
	Create(ctx context.Context, userID string) (token string, expires time.Time, err error)
	Lookup(ctx context.Context, token string) (userID string, ok bool, err error)
	Delete(ctx context.Context, token string) error
}

func newToken() (string, [32]byte, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", [32]byte{}, err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	return token, sha256.Sum256([]byte(token)), nil
}

// Sessions — сессии в памяти, для тестов и запуска без базы.
type Sessions struct {
	Now func() time.Time

	mu sync.Mutex
	m  map[[32]byte]session
}

type session struct {
	userID  string
	expires time.Time
}

func NewSessions() *Sessions {
	return &Sessions{Now: time.Now, m: map[[32]byte]session{}}
}

func (s *Sessions) Create(_ context.Context, userID string) (string, time.Time, error) {
	token, key, err := newToken()
	if err != nil {
		return "", time.Time{}, err
	}
	now := s.Now()
	expires := now.Add(SessionTTL)

	s.mu.Lock()
	defer s.mu.Unlock()
	for k, v := range s.m {
		if now.After(v.expires) {
			delete(s.m, k)
		}
	}
	s.m[key] = session{userID: userID, expires: expires}
	return token, expires, nil
}

func (s *Sessions) Lookup(_ context.Context, token string) (string, bool, error) {
	key := sha256.Sum256([]byte(token))
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.m[key]
	if !ok {
		return "", false, nil
	}
	if s.Now().After(sess.expires) {
		delete(s.m, key)
		return "", false, nil
	}
	return sess.userID, true, nil
}

func (s *Sessions) Delete(_ context.Context, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.m, sha256.Sum256([]byte(token)))
	return nil
}
