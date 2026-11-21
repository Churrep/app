// Package push — уведомления через Web Push (VAPID).
// На iPhone push приходит, только если приложение добавлено на экран «Домой» (iOS 16.4+).
package push

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Keys struct {
	Public  string `json:"public"`
	Private string `json:"private"`
}

// LoadKeys берёт VAPID-ключи из переменных окружения, иначе из файла (создаёт его при первом запуске).
// Ключи должны быть постоянными: при смене все подписки браузеров перестают работать.
func LoadKeys(path string) (Keys, error) {
	if pub, priv := os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY"); pub != "" && priv != "" {
		return Keys{pub, priv}, nil
	}
	if b, err := os.ReadFile(path); err == nil {
		var k Keys
		if err := json.Unmarshal(b, &k); err == nil && k.Public != "" && k.Private != "" {
			return k, nil
		}
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return Keys{}, err
	}
	k := Keys{pub, priv}
	b, _ := json.Marshal(k)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return Keys{}, err
	}
	return k, os.WriteFile(path, b, 0o600)
}

type Message struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag,omitempty"` // одинаковый тег заменяет прошлое уведомление, а не копит их
}

type Service struct {
	db      *pgxpool.Pool
	keys    Keys
	subject string
	log     *slog.Logger
	client  webpush.HTTPClient
}

func NewService(db *pgxpool.Pool, keys Keys, subject string, log *slog.Logger) *Service {
	return &Service{db: db, keys: keys, subject: subject, log: log, client: &http.Client{Timeout: 15 * time.Second}}
}

func (s *Service) PublicKey() string { return s.keys.Public }

var ErrBadSubscription = errors.New("bad subscription")

func (s *Service) Subscribe(ctx context.Context, userID string, sub webpush.Subscription) error {
	if !strings.HasPrefix(sub.Endpoint, "https://") || len(sub.Endpoint) > 1000 || sub.Keys.P256dh == "" || sub.Keys.Auth == "" {
		return ErrBadSubscription
	}
	// Один браузер — одна подписка; если на устройстве вошёл другой человек, подписка переходит к нему.
	_, err := s.db.Exec(ctx, `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4)
		ON CONFLICT (endpoint) DO UPDATE SET user_id = $2, p256dh = $3, auth = $4, created_at = now()`,
		sub.Endpoint, userID, sub.Keys.P256dh, sub.Keys.Auth)
	return err
}

func (s *Service) Unsubscribe(ctx context.Context, userID, endpoint string) error {
	_, err := s.db.Exec(ctx, `DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, endpoint, userID)
	return err
}

func (s *Service) Enabled(ctx context.Context, userID string) (bool, error) {
	var ok bool
	err := s.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = $1)`, userID).Scan(&ok)
	return ok, err
}

// SendAsync отправляет уведомление на все устройства человека в фоне: запрос пользователя не ждёт push-сервисы.
func (s *Service) SendAsync(userID string, m Message) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := s.Send(ctx, userID, m); err != nil {
			s.log.Warn("push", "err", err)
		}
	}()
}

func (s *Service) Send(ctx context.Context, userID string, m Message) error {
	rows, err := s.db.Query(ctx, `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	subs, err := pgx.CollectRows(rows, func(r pgx.CollectableRow) (webpush.Subscription, error) {
		var sub webpush.Subscription
		return sub, r.Scan(&sub.Endpoint, &sub.Keys.P256dh, &sub.Keys.Auth)
	})
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(m)
	for _, sub := range subs {
		resp, err := webpush.SendNotificationWithContext(ctx, payload, &sub, &webpush.Options{
			HTTPClient:      s.client,
			Subscriber:      s.subject,
			VAPIDPublicKey:  s.keys.Public,
			VAPIDPrivateKey: s.keys.Private,
			TTL:             24 * 3600,
			Urgency:         webpush.UrgencyNormal,
			Topic:           m.Tag,
		})
		if err != nil {
			s.log.Warn("push send", "err", err)
			continue
		}
		resp.Body.Close()
		// 404/410 — подписка больше не действует (удалили приложение, отозвали разрешение).
		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
			s.db.Exec(ctx, `DELETE FROM push_subscriptions WHERE endpoint = $1`, sub.Endpoint)
		} else if resp.StatusCode >= 400 {
			s.log.Warn("push rejected", "status", resp.StatusCode)
		}
	}
	return nil
}
