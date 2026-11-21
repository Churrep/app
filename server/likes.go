package server

import (
	"encoding/json"
	"net/http"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"

	"music/profile"
)

func (s *Server) routesLikes(m *http.ServeMux) {
	m.HandleFunc("POST /likes", s.withExt(s.withOnboarded(s.handleLike)))
	m.HandleFunc("DELETE /likes/{id}", s.withExt(s.withOnboarded(s.handleUnlike)))
	m.HandleFunc("GET /likes/incoming", s.withExt(s.withOnboarded(s.handleIncoming)))
	m.HandleFunc("GET /likes/incoming/count", s.withExt(s.withOnboarded(s.handleIncomingCount)))
	m.HandleFunc("POST /likes/incoming/{id}/dismiss", s.withExt(s.withOnboarded(s.handleDismiss)))
	m.HandleFunc("GET /users/{id}/relation", s.withExt(s.withOnboarded(s.handleRelation)))
	m.HandleFunc("GET /matches", s.withExt(s.withOnboarded(s.handleMatches)))
	m.HandleFunc("GET /matches/{id}", s.withExt(s.withOnboarded(s.handleMatch)))

	m.HandleFunc("GET /push/key", s.withExt(s.withUser(s.handlePushKey)))
	m.HandleFunc("POST /push/subscribe", s.withExt(s.withUser(s.handlePushSubscribe)))
	m.HandleFunc("POST /push/unsubscribe", s.withExt(s.withUser(s.handlePushUnsubscribe)))
}

func (s *Server) handleLike(w http.ResponseWriter, r *http.Request, u profile.User) {
	var req struct {
		ToUserID string `json:"to_user_id"`
		VideoID  string `json:"video_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	res, err := s.ext.Likes.Like(r.Context(), u.ID, req.ToUserID, req.VideoID, s.now())
	if err != nil {
		s.fail(w, "like", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"matched": res.Matched, "match_id": res.MatchID})
}

func (s *Server) handleUnlike(w http.ResponseWriter, r *http.Request, u profile.User) {
	if err := s.ext.Likes.Unlike(r.Context(), u.ID, r.PathValue("id")); err != nil {
		s.fail(w, "unlike", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleIncoming(w http.ResponseWriter, r *http.Request, u profile.User) {
	list, err := s.ext.Likes.Incoming(r.Context(), u.ID, s.now())
	if err != nil {
		s.fail(w, "incoming likes", err)
		return
	}
	type preview struct {
		Type      string          `json:"type"`
		PosterURL string          `json:"poster_url"`
		Peaks     json.RawMessage `json:"peaks"`
	}
	type item struct {
		Author  profile.Author `json:"author"`
		LikedAt time.Time      `json:"liked_at"`
		Preview *preview       `json:"preview"`
	}
	out := make([]item, len(list))
	for i, in := range list {
		out[i] = item{Author: in.Author, LikedAt: in.LikedAt}
		if in.VideoType != "" {
			out[i].Preview = &preview{in.VideoType, s.url(in.PosterKey), in.VideoPeaks}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handleIncomingCount(w http.ResponseWriter, r *http.Request, u profile.User) {
	n, err := s.ext.Likes.IncomingCount(r.Context(), u.ID)
	if err != nil {
		s.fail(w, "incoming count", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": n})
}

func (s *Server) handleDismiss(w http.ResponseWriter, r *http.Request, u profile.User) {
	if err := s.ext.Likes.Dismiss(r.Context(), u.ID, r.PathValue("id")); err != nil {
		s.fail(w, "dismiss like", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRelation(w http.ResponseWriter, r *http.Request, u profile.User) {
	rel, err := s.ext.Likes.Relation(r.Context(), u.ID, r.PathValue("id"))
	if err != nil {
		s.fail(w, "relation", err)
		return
	}
	writeJSON(w, http.StatusOK, rel)
}

type matchView struct {
	ID           string         `json:"id"`
	Other        profile.Author `json:"other"`
	CreatedAt    time.Time      `json:"created_at"`
	DMRestricted bool           `json:"dm_restricted"`
}

func (s *Server) handleMatches(w http.ResponseWriter, r *http.Request, u profile.User) {
	list, err := s.ext.Likes.Matches(r.Context(), u.ID, s.now())
	if err != nil {
		s.fail(w, "matches", err)
		return
	}
	out := make([]matchView, len(list))
	for i, m := range list {
		out[i] = matchView{m.ID, m.Other, m.CreatedAt, m.DMRestricted}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handleMatch(w http.ResponseWriter, r *http.Request, u profile.User) {
	m, err := s.ext.Likes.GetMatch(r.Context(), u.ID, r.PathValue("id"), s.now())
	if err != nil {
		s.fail(w, "match", err)
		return
	}
	writeJSON(w, http.StatusOK, matchView{m.ID, m.Other, m.CreatedAt, m.DMRestricted})
}

func (s *Server) pushReady(w http.ResponseWriter) bool {
	if s.ext.Push == nil {
		writeError(w, http.StatusServiceUnavailable, "push_unavailable", "Уведомления пока недоступны")
		return false
	}
	return true
}

func (s *Server) handlePushKey(w http.ResponseWriter, r *http.Request, u profile.User) {
	if !s.pushReady(w) {
		return
	}
	enabled, err := s.ext.Push.Enabled(r.Context(), u.ID)
	if err != nil {
		s.fail(w, "push status", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"public_key": s.ext.Push.PublicKey(), "enabled": enabled})
}

func (s *Server) handlePushSubscribe(w http.ResponseWriter, r *http.Request, u profile.User) {
	if !s.pushReady(w) {
		return
	}
	var sub webpush.Subscription
	if !decode(w, r, &sub) {
		return
	}
	if err := s.ext.Push.Subscribe(r.Context(), u.ID, sub); err != nil {
		writeError(w, http.StatusBadRequest, "bad_subscription", "Не получилось включить уведомления")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handlePushUnsubscribe(w http.ResponseWriter, r *http.Request, u profile.User) {
	if !s.pushReady(w) {
		return
	}
	var req struct {
		Endpoint string `json:"endpoint"`
	}
	if !decode(w, r, &req) {
		return
	}
	if err := s.ext.Push.Unsubscribe(r.Context(), u.ID, req.Endpoint); err != nil {
		s.fail(w, "push unsubscribe", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
