package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"music/apperr"
	"music/auth"
	"music/likes"
	"music/media"
	"music/profile"
	"music/push"
	"music/tracks"
	"music/venues"
	"music/videos"
)

const cookieName = "session"

type Config struct {
	CookieSecure     bool
	TrustProxy       bool
	TelegramBotToken string
}

type Server struct {
	cfg         Config
	users       profile.Store
	otp         *auth.OTP
	sessions    auth.SessionStore
	log         *slog.Logger
	now         func() time.Time
	authLimiter *limiter

	uploadLimiter *limiter
	mux           *http.ServeMux
	ext           *Extensions
}

type Extensions struct {
	Media  *media.Media
	Videos *videos.Service
	Tracks *tracks.Service
	Venues *venues.Store
	Likes  *likes.Service
	Push   *push.Service
}

func New(cfg Config, users profile.Store, otp *auth.OTP, sessions auth.SessionStore, logger *slog.Logger, ext *Extensions) *Server {
	s := &Server{
		ext:           ext,
		cfg:           cfg,
		users:         users,
		otp:           otp,
		sessions:      sessions,
		log:           logger,
		now:           func() time.Time { return time.Now().UTC() },
		authLimiter:   newLimiter(30, 10*time.Minute),
		uploadLimiter: newLimiter(20, time.Hour),
	}
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	m.HandleFunc("GET /catalog", s.handleCatalog)
	m.HandleFunc("POST /auth/otp", s.limitAuth(s.handleOTP))
	m.HandleFunc("POST /auth/verify", s.limitAuth(s.handleVerify))
	m.HandleFunc("POST /auth/telegram", s.limitAuth(s.handleTelegram))
	m.HandleFunc("POST /auth/logout", s.handleLogout)
	m.HandleFunc("GET /me", s.withUser(s.handleGetMe))
	m.HandleFunc("PATCH /me", s.withUser(s.handlePatchMe))
	m.HandleFunc("GET /users/{id}", s.withUser(s.handleGetUser))
	s.routesExt(m)
	s.mux = m
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if v := recover(); v != nil {
			s.log.Error("panic", "err", v, "path", r.URL.Path)
			writeError(w, http.StatusInternalServerError, "internal", "Что-то сломалось. Попробуй ещё раз")
		}
	}()
	w.Header().Set("Cache-Control", "no-store")
	upload := false
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		upload = ct == "multipart/form-data" && r.Header.Get("X-Upload") == "1"
		if ct != "application/json" && !upload {
			writeError(w, http.StatusUnsupportedMediaType, "json_required", "Нужен Content-Type: application/json")
			return
		}
	}
	if !upload {
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	}
	s.mux.ServeHTTP(w, r)
}

type userHandler func(w http.ResponseWriter, r *http.Request, u profile.User)

func (s *Server) withUser(h userHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Войди, чтобы продолжить")
			return
		}
		id, ok, err := s.sessions.Lookup(r.Context(), c.Value)
		if err != nil {
			s.internal(w, "lookup session", err)
			return
		}
		if !ok {
			s.clearCookie(w)
			writeError(w, http.StatusUnauthorized, "unauthorized", "Войди, чтобы продолжить")
			return
		}
		u, err := s.users.Get(r.Context(), id)
		if errors.Is(err, profile.ErrNotFound) {
			s.sessions.Delete(r.Context(), c.Value)
			s.clearCookie(w)
			writeError(w, http.StatusUnauthorized, "unauthorized", "Войди, чтобы продолжить")
			return
		}
		if err != nil {
			s.internal(w, "get user", err)
			return
		}
		h(w, r, u)
	}
}

func (s *Server) limitAuth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authLimiter.allow(s.clientIP(r), s.now()) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Слишком много попыток. Подожди немного")
			return
		}
		h(w, r)
	}
}

func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustProxy {
		if ip := r.Header.Get("CF-Connecting-IP"); ip != "" {
			return ip
		}
		if ip := r.Header.Get("X-Real-IP"); ip != "" {
			return ip
		}
		// Туннель дописывает адрес клиента в конец X-Forwarded-For; начало клиент может подделать.
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) startSession(w http.ResponseWriter, r *http.Request, userID string) error {
	if old, err := r.Cookie(cookieName); err == nil {
		if err := s.sessions.Delete(r.Context(), old.Value); err != nil {
			return err
		}
	}
	token, expires, err := s.sessions.Create(r.Context(), userID)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(time.Until(expires).Seconds()),
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func (s *Server) clearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   s.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
	})
}

type apiError struct {
	Error   string `json:"error"`
	Message string `json:"message"`
	Field   string `json:"field,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, apiError{Error: code, Message: msg})
}

// fail отвечает на ошибку сервиса: apperr.Error — как есть, остальное — 500.
func (s *Server) fail(w http.ResponseWriter, what string, err error) {
	var ae *apperr.Error
	if errors.As(err, &ae) {
		writeJSON(w, ae.Status, apiError{Error: ae.Code, Message: ae.Message, Field: ae.Field})
		return
	}
	s.internal(w, what, err)
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", "Не получилось прочитать запрос")
		return false
	}
	return true
}

// limiter — простой лимит запросов на ключ в фиксированном окне.
type limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string]*hitWindow
}

type hitWindow struct {
	start time.Time
	count int
}

func newLimiter(limit int, window time.Duration) *limiter {
	return &limiter{limit: limit, window: window, hits: map[string]*hitWindow{}}
}

func (l *limiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.hits) > 10_000 {
		for k, h := range l.hits {
			if now.Sub(h.start) > l.window {
				delete(l.hits, k)
			}
		}
	}
	h := l.hits[key]
	if h == nil || now.Sub(h.start) > l.window {
		l.hits[key] = &hitWindow{start: now, count: 1}
		return true
	}
	h.count++
	return h.count <= l.limit
}
