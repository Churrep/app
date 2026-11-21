package server

import (
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"music/auth"
	"music/profile"
)

func (s *Server) handleCatalog(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"instruments": profile.Instruments,
		"genres":      profile.Genres,
		"goals":       profile.Goals,
		"looking_for": profile.LookingFor,
		"levels":      profile.Levels,
		"city":        profile.City,
		"max_genres":  profile.MaxGenres,
		"video_tags":  profile.VideoTags,
	})
}

func (s *Server) handleOTP(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
	}
	if !decode(w, r, &req) {
		return
	}
	phone, err := auth.NormalizePhone(req.Phone)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_phone", "Проверь номер: нужен российский мобильный")
		return
	}
	wait, err := s.otp.Request(r.Context(), phone)
	switch {
	case errors.Is(err, auth.ErrTooSoon):
		sec := int(math.Ceil(wait.Seconds()))
		w.Header().Set("Retry-After", strconv.Itoa(sec))
		writeError(w, http.StatusTooManyRequests, "too_soon", fmt.Sprintf("Код уже отправлен. Новый можно запросить через %d сек", sec))
		return
	case errors.Is(err, auth.ErrTooManyRequests):
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
		writeError(w, http.StatusTooManyRequests, "too_many_codes", "Слишком много кодов. Попробуй позже")
		return
	case err != nil:
		s.log.Error("send sms", "err", err)
		writeError(w, http.StatusBadGateway, "sms_failed", "Не получилось отправить СМС. Попробуй ещё раз")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"retry_after": int(s.otp.Cooldown.Seconds())})
}

func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
		Code  string `json:"code"`
	}
	if !decode(w, r, &req) {
		return
	}
	phone, err := auth.NormalizePhone(req.Phone)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_phone", "Проверь номер: нужен российский мобильный")
		return
	}
	code := strings.TrimSpace(req.Code)
	if !isDigits(code, 6) {
		writeError(w, http.StatusBadRequest, "bad_code", "Код — это 6 цифр")
		return
	}
	switch err := s.otp.Verify(phone, code); {
	case errors.Is(err, auth.ErrCodeInvalid):
		writeError(w, http.StatusBadRequest, "wrong_code", "Неверный код")
		return
	case errors.Is(err, auth.ErrCodeExpired):
		writeError(w, http.StatusBadRequest, "code_expired", "Код устарел, запроси новый")
		return
	case errors.Is(err, auth.ErrTooManyAttempts):
		writeError(w, http.StatusTooManyRequests, "too_many_attempts", "Слишком много попыток, запроси новый код")
		return
	case err != nil:
		s.internal(w, "verify otp", err)
		return
	}

	now := s.now()
	u, created, err := s.users.GetOrCreateByPhone(r.Context(), phone, now)
	if err != nil {
		s.internal(w, "get or create user", err)
		return
	}
	if err := s.startSession(w, r, u.ID); err != nil {
		s.internal(w, "create session", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u.Me(now), "is_new": created})
}

func (s *Server) handleTelegram(w http.ResponseWriter, r *http.Request) {
	if s.cfg.TelegramBotToken == "" {
		writeError(w, http.StatusServiceUnavailable, "telegram_disabled", "Вход через Telegram пока недоступен")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_json", "Не получилось прочитать запрос")
		return
	}
	now := s.now()
	tg, err := auth.VerifyTelegram(s.cfg.TelegramBotToken, body, now)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "telegram_invalid", "Не получилось войти через Telegram. Попробуй ещё раз")
		return
	}
	p := profile.TelegramProfile{
		ID:       tg.ID,
		Username: tg.Username,
		Name:     truncateRunes(strings.TrimSpace(tg.FirstName+" "+tg.LastName), 40),
	}
	if strings.HasPrefix(tg.PhotoURL, "https://") {
		p.PhotoURL = tg.PhotoURL
	}
	u, created, err := s.users.GetOrCreateByTelegram(r.Context(), p, now)
	if err != nil {
		s.internal(w, "get or create telegram user", err)
		return
	}
	if err := s.startSession(w, r, u.ID); err != nil {
		s.internal(w, "create session", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u.Me(now), "is_new": created})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		if err := s.sessions.Delete(r.Context(), c.Value); err != nil {
			s.internal(w, "delete session", err)
			return
		}
	}
	s.clearCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleGetMe(w http.ResponseWriter, _ *http.Request, u profile.User) {
	writeJSON(w, http.StatusOK, u.Me(s.now()))
}

func (s *Server) handlePatchMe(w http.ResponseWriter, r *http.Request, u profile.User) {
	var p profile.Patch
	if !decode(w, r, &p) {
		return
	}
	now := s.now()
	updated, err := s.users.Update(r.Context(), u.ID, func(c *profile.User) error { return p.Apply(c, now) })
	var ve *profile.ValidationError
	switch {
	case errors.As(err, &ve):
		writeJSON(w, http.StatusBadRequest, apiError{Error: ve.Code, Message: ve.Message, Field: ve.Field})
		return
	case err != nil:
		s.internal(w, "update user", err)
		return
	}
	writeJSON(w, http.StatusOK, updated.Me(now))
}

func (s *Server) handleGetUser(w http.ResponseWriter, r *http.Request, viewer profile.User) {
	if !viewer.Onboarding().Complete {
		writeError(w, http.StatusForbidden, "onboarding_required", "Сначала закончи анкету")
		return
	}
	target, err := s.users.Get(r.Context(), r.PathValue("id"))
	if err != nil && !errors.Is(err, profile.ErrNotFound) {
		s.internal(w, "get user", err)
		return
	}
	if err != nil || !target.Onboarding().Complete {
		writeError(w, http.StatusNotFound, "not_found", "Профиль не найден")
		return
	}
	writeJSON(w, http.StatusOK, target.Public(s.now()))
}

func (s *Server) internal(w http.ResponseWriter, what string, err error) {
	s.log.Error(what, "err", err)
	writeError(w, http.StatusInternalServerError, "internal", "Что-то сломалось. Попробуй ещё раз")
}

func isDigits(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
