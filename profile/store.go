package profile

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"sync"
	"time"
)

var ErrNotFound = errors.New("user not found")

// TelegramProfile — данные из Telegram Login для создания аккаунта.
type TelegramProfile struct {
	ID       int64
	Username string
	Name     string
	PhotoURL string
}

// Store — хранилище пользователей: PostgresStore для работы, MemoryStore для тестов и запуска без базы.
type Store interface {
	Get(ctx context.Context, id string) (User, error)
	GetOrCreateByPhone(ctx context.Context, phone string, now time.Time) (u User, created bool, err error)
	GetOrCreateByTelegram(ctx context.Context, tg TelegramProfile, now time.Time) (u User, created bool, err error)
	// Update атомарно применяет fn к копии пользователя и сохраняет её, если fn вернула nil.
	Update(ctx context.Context, id string, fn func(*User) error) (User, error)
}

type MemoryStore struct {
	mu         sync.RWMutex
	users      map[string]*User
	byPhone    map[string]string
	byTelegram map[int64]string
}

func NewMemoryStore() *MemoryStore {
	return &MemoryStore{
		users:      map[string]*User{},
		byPhone:    map[string]string{},
		byTelegram: map[int64]string{},
	}
}

func (s *MemoryStore) Get(_ context.Context, id string) (User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[id]
	if !ok || u.DeletedAt != nil {
		return User{}, ErrNotFound
	}
	return *u, nil
}

func (s *MemoryStore) GetOrCreateByPhone(_ context.Context, phone string, now time.Time) (User, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.byPhone[phone]; ok && s.users[id].DeletedAt == nil {
		return *s.users[id], false, nil
	}
	u := newUser(now)
	u.Phone = phone
	s.users[u.ID] = &u
	s.byPhone[phone] = u.ID
	return u, true, nil
}

func (s *MemoryStore) GetOrCreateByTelegram(_ context.Context, tg TelegramProfile, now time.Time) (User, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id, ok := s.byTelegram[tg.ID]; ok && s.users[id].DeletedAt == nil {
		return *s.users[id], false, nil
	}
	u := newUser(now)
	u.TelegramID = tg.ID
	u.TelegramUsername = tg.Username
	u.Name = tg.Name
	u.PhotoURL = tg.PhotoURL
	s.users[u.ID] = &u
	s.byTelegram[tg.ID] = u.ID
	return u, true, nil
}

func (s *MemoryStore) Update(_ context.Context, id string, fn func(*User) error) (User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[id]
	if !ok || u.DeletedAt != nil {
		return User{}, ErrNotFound
	}
	c := *u
	if err := fn(&c); err != nil {
		return User{}, err
	}
	c.UpdatedAt = time.Now().UTC()
	s.users[id] = &c
	return c, nil
}

func newUser(now time.Time) User {
	return User{
		ID:           newID(),
		ShowDistrict: true,
		Theme:        "dark",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}

// newID — UUID v4.
func newID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F') {
				return false
			}
		}
	}
	return true
}

// IsUUID — проверка id из URL до запроса в базу.
func IsUUID(s string) bool { return isUUID(s) }
