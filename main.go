package main

import (
	"context"
	"crypto/rand"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"music/auth"
	"music/db"
	"music/likes"
	"music/media"
	"music/profile"
	"music/server"
	"music/tracks"
	"music/videos"
)

func main() {
	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	// СМС с кодом: через sms.ru, если задан SMSRU_API_ID. Иначе код пишется в лог —
	// только при явном SMS_LOG_CODES=true, чтобы это случайно не уехало в прод.
	var sms auth.SMSSender
	switch {
	case os.Getenv("SMSRU_API_ID") != "":
		sms = auth.SMSRu{APIID: os.Getenv("SMSRU_API_ID"), Test: os.Getenv("SMSRU_TEST") == "true", From: os.Getenv("SMSRU_FROM")}
		if os.Getenv("SMSRU_TEST") == "true" {
			logger.Warn("SMSRU_TEST=true: sms.ru проверяет запросы, но СМС не отправляет")
		}
	case os.Getenv("SMS_LOG_CODES") == "true":
		logger.Warn("СМС не отправляются: коды пишутся в лог. Для настоящих СМС задай SMSRU_API_ID")
		sms = auth.LogSender{Logger: logger}
	default:
		logger.Error("Нужен SMSRU_API_ID (ключ sms.ru) или SMS_LOG_CODES=true для разработки")
		os.Exit(1)
	}

	cfg := server.Config{
		CookieSecure:     os.Getenv("COOKIE_SECURE") != "false",
		TrustProxy:       os.Getenv("TRUST_PROXY") == "true",
		TelegramBotToken: os.Getenv("TELEGRAM_BOT_TOKEN"),
	}
	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}

	var (
		users    profile.Store
		sessions auth.SessionStore
		ext      *server.Extensions
	)
	if url := os.Getenv("DATABASE_URL"); url != "" {
		pool, err := db.Open(context.Background(), url)
		if err != nil {
			logger.Error("база данных", "err", err)
			os.Exit(1)
		}
		defer pool.Close()
		if err := db.Migrate(context.Background(), pool); err != nil {
			logger.Error("миграции", "err", err)
			os.Exit(1)
		}
		users, sessions = profile.NewPostgresStore(pool), auth.NewPostgresSessions(pool)
		m, err := newMedia(logger)
		if err != nil {
			logger.Error("хранилище файлов", "err", err)
			os.Exit(1)
		}
		ext = &server.Extensions{
			Media:  m,
			Videos: videos.NewService(pool, m),
			Likes:  likes.NewService(pool),
			Tracks: tracks.NewService(pool, m),
		}
		if m.FFErr == nil {
			if err := ext.Videos.Resume(context.Background()); err != nil {
				logger.Error("очередь видео", "err", err)
			}
			if err := ext.Tracks.Resume(context.Background()); err != nil {
				logger.Error("очередь дорожек", "err", err)
			}
		}
	} else {
		logger.Warn("DATABASE_URL не задан: данные хранятся в памяти и пропадут при перезапуске")
		users, sessions = profile.NewMemoryStore(), auth.NewSessions()
	}

	srv := server.New(cfg, users, auth.NewOTP(sms), sessions, logger, ext)
	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           srv,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Minute, // загрузка видео и минусов по мобильному интернету
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		logger.Info("сервер запущен", "addr", addr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("сервер упал", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		logger.Error("остановка", "err", err)
	}
}

func env(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

func newMedia(logger *slog.Logger) (*media.Media, error) {
	st, err := media.NewStorage(env("MEDIA_DIR", "data/media"))
	if err != nil {
		return nil, err
	}
	secret := []byte(os.Getenv("MEDIA_SECRET"))
	if len(secret) == 0 {
		logger.Warn("MEDIA_SECRET не задан: ссылки на файлы перестанут работать после перезапуска")
		secret = make([]byte, 32)
		rand.Read(secret)
	}
	ff := media.FFmpeg{Bin: env("FFMPEG", "ffmpeg"), Probe: env("FFPROBE", "ffprobe")}
	m := &media.Media{
		Storage: st,
		Signer:  &media.Signer{Secret: secret, Base: env("MEDIA_BASE_URL", "/api/media"), TTL: 24 * time.Hour, Now: time.Now},
		FF:      ff,
		Queue:   media.NewQueue(2, logger),
		FFErr:   ff.Check(),
	}
	if m.FFErr != nil {
		logger.Warn("FFmpeg не найден: загрузка видео и дорожек отключена", "err", m.FFErr)
	}
	return m, nil
}
