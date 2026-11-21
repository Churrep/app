package server

import (
	"encoding/json"
	"net/http"
	"time"

	"music/profile"
)

func (s *Server) routesLikes(m *http.ServeMux) {
	// Лайк записи — на знакомства не влияет.
	m.HandleFunc("POST /videos/{id}/like", s.withExt(s.withOnboarded(s.handleLikeVideo)))
	m.HandleFunc("DELETE /videos/{id}/like", s.withExt(s.withOnboarded(s.handleUnlikeVideo)))
	m.HandleFunc("GET /likes/incoming", s.withExt(s.withOnboarded(s.handleIncomingLikes)))
	// «Хочу поиграть» — человеку; два встречных предложения — совпадение.
	m.HandleFunc("POST /invites", s.withExt(s.withOnboarded(s.handleInvite)))
	m.HandleFunc("DELETE /invites/{id}", s.withExt(s.withOnboarded(s.handleWithdraw)))
	m.HandleFunc("GET /invites/incoming", s.withExt(s.withOnboarded(s.handleIncoming)))
	m.HandleFunc("GET /invites/incoming/count", s.withExt(s.withOnboarded(s.handleIncomingCount)))
	m.HandleFunc("POST /invites/incoming/{id}/dismiss", s.withExt(s.withOnboarded(s.handleDismiss)))
	m.HandleFunc("GET /users/{id}/relation", s.withExt(s.withOnboarded(s.handleRelation)))
	m.HandleFunc("GET /matches", s.withExt(s.withOnboarded(s.handleMatches)))
}

func (s *Server) handleLikeVideo(w http.ResponseWriter, r *http.Request, u profile.User) {
	if err := s.ext.Likes.LikeVideo(r.Context(), u.ID, r.PathValue("id")); err != nil {
		s.fail(w, "like video", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUnlikeVideo(w http.ResponseWriter, r *http.Request, u profile.User) {
	if err := s.ext.Likes.UnlikeVideo(r.Context(), u.ID, r.PathValue("id")); err != nil {
		s.fail(w, "unlike video", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// previewView — превью записи для списков (входящие предложения и лайки).
type previewView struct {
	ID        string          `json:"id,omitempty"`
	Type      string          `json:"type"`
	PosterURL string          `json:"poster_url"`
	Peaks     json.RawMessage `json:"peaks"`
}

func (s *Server) handleIncomingLikes(w http.ResponseWriter, r *http.Request, u profile.User) {
	list, err := s.ext.Likes.IncomingLikes(r.Context(), u.ID, s.now())
	if err != nil {
		s.fail(w, "incoming likes", err)
		return
	}
	type item struct {
		Author  profile.Author `json:"author"`
		LikedAt time.Time      `json:"liked_at"`
		Video   previewView    `json:"video"`
	}
	out := make([]item, len(list))
	for i, l := range list {
		out[i] = item{l.Author, l.LikedAt, previewView{l.VideoID, l.VideoType, s.url(l.PosterKey), l.VideoPeaks}}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handleInvite(w http.ResponseWriter, r *http.Request, u profile.User) {
	var req struct {
		ToUserID string `json:"to_user_id"`
	}
	if !decode(w, r, &req) {
		return
	}
	res, err := s.ext.Likes.Invite(r.Context(), u.ID, req.ToUserID, s.now())
	if err != nil {
		s.fail(w, "invite", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"mutual": res.Mutual})
}

func (s *Server) handleWithdraw(w http.ResponseWriter, r *http.Request, u profile.User) {
	if err := s.ext.Likes.Withdraw(r.Context(), u.ID, r.PathValue("id")); err != nil {
		s.fail(w, "withdraw invite", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleIncoming(w http.ResponseWriter, r *http.Request, u profile.User) {
	list, err := s.ext.Likes.Incoming(r.Context(), u.ID, s.now())
	if err != nil {
		s.fail(w, "incoming invites", err)
		return
	}
	type item struct {
		Author    profile.Author `json:"author"`
		InvitedAt time.Time      `json:"invited_at"`
		Preview   *previewView   `json:"preview"`
	}
	out := make([]item, len(list))
	for i, in := range list {
		out[i] = item{Author: in.Author, InvitedAt: in.InvitedAt}
		if in.VideoType != "" {
			out[i].Preview = &previewView{Type: in.VideoType, PosterURL: s.url(in.PosterKey), Peaks: in.VideoPeaks}
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
		s.fail(w, "dismiss invite", err)
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

// matchView — совпадение. Отдельного ID нет: для перехода в профиль достаточно ID второго музыканта.
type matchView struct {
	Other     profile.Author `json:"other"`
	CreatedAt time.Time      `json:"created_at"`
}

func (s *Server) handleMatches(w http.ResponseWriter, r *http.Request, u profile.User) {
	list, err := s.ext.Likes.Matches(r.Context(), u.ID, s.now())
	if err != nil {
		s.fail(w, "matches", err)
		return
	}
	out := make([]matchView, len(list))
	for i, m := range list {
		out[i] = matchView{m.Other, m.CreatedAt}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}
