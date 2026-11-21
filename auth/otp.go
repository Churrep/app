package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"sync"
	"time"
)

var (
	ErrTooSoon         = errors.New("code requested too soon")
	ErrTooManyRequests = errors.New("too many codes requested")
	ErrCodeInvalid     = errors.New("invalid code")
	ErrCodeExpired     = errors.New("code expired or not requested")
	ErrTooManyAttempts = errors.New("too many attempts")
)

// SMSSender отправляет СМС. Реального провайдера пока нет.
type SMSSender interface {
	Send(ctx context.Context, phone, text string) error
}

// LogSender пишет код в лог вместо отправки. Только для разработки.
type LogSender struct{ Logger *slog.Logger }

func (s LogSender) Send(_ context.Context, phone, text string) error {
	s.Logger.Warn("СМС не отправлено, провайдер не подключён", "phone", phone, "text", text)
	return nil
}

type OTP struct {
	Sender      SMSSender
	TTL         time.Duration // сколько живёт код
	Cooldown    time.Duration // пауза между запросами кода
	MaxAttempts int           // попыток ввода на один код
	MaxPerHour  int           // кодов в час на номер
	Now         func() time.Time

	mu      sync.Mutex
	entries map[string]*otpEntry
}

type otpEntry struct {
	hash     [32]byte
	expires  time.Time // ноль — кода нет
	attempts int
	lastSent time.Time
	sent     []time.Time
}

func NewOTP(sender SMSSender) *OTP {
	return &OTP{
		Sender:      sender,
		TTL:         5 * time.Minute,
		Cooldown:    60 * time.Second,
		MaxAttempts: 5,
		MaxPerHour:  5,
		Now:         time.Now,
		entries:     map[string]*otpEntry{},
	}
}

// Request создаёт код и отправляет его. При ErrTooSoon/ErrTooManyRequests возвращает, сколько ждать.
func (o *OTP) Request(ctx context.Context, phone string) (time.Duration, error) {
	now := o.Now()
	o.mu.Lock()
	o.sweep(now)
	e := o.entries[phone]
	if e == nil {
		e = &otpEntry{}
		o.entries[phone] = e
	}
	if wait := e.lastSent.Add(o.Cooldown).Sub(now); wait > 0 {
		o.mu.Unlock()
		return wait, ErrTooSoon
	}
	recent := e.sent[:0]
	for _, t := range e.sent {
		if now.Sub(t) < time.Hour {
			recent = append(recent, t)
		}
	}
	e.sent = recent
	if len(recent) >= o.MaxPerHour {
		o.mu.Unlock()
		return recent[0].Add(time.Hour).Sub(now), ErrTooManyRequests
	}

	code, err := randomCode()
	if err != nil {
		o.mu.Unlock()
		return 0, err
	}
	h := hashCode(phone, code)
	e.hash, e.expires, e.attempts, e.lastSent = h, now.Add(o.TTL), 0, now
	e.sent = append(e.sent, now)
	o.mu.Unlock()

	if err := o.Sender.Send(ctx, phone, "Код для входа: "+code); err != nil {
		o.mu.Lock()
		if e.hash == h {
			e.expires = time.Time{}
		}
		o.mu.Unlock()
		return 0, err
	}
	return 0, nil
}

// Verify проверяет код. Код одноразовый.
func (o *OTP) Verify(phone, code string) error {
	now := o.Now()
	o.mu.Lock()
	defer o.mu.Unlock()
	e := o.entries[phone]
	if e == nil || e.expires.IsZero() || now.After(e.expires) {
		return ErrCodeExpired
	}
	if e.attempts >= o.MaxAttempts {
		return ErrTooManyAttempts
	}
	e.attempts++
	h := hashCode(phone, code)
	if subtle.ConstantTimeCompare(h[:], e.hash[:]) != 1 {
		return ErrCodeInvalid
	}
	e.expires = time.Time{}
	e.hash = [32]byte{}
	return nil
}

func (o *OTP) sweep(now time.Time) {
	for phone, e := range o.entries {
		if now.After(e.expires) && now.Sub(e.lastSent) > time.Hour {
			delete(o.entries, phone)
		}
	}
}

func randomCode() (string, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", n.Int64()), nil
}

func hashCode(phone, code string) [32]byte {
	return sha256.Sum256([]byte(phone + ":" + code))
}
