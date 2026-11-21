package server

import (
	"net/http"
	"strings"

	"music/media"
	"music/profile"
)

// Аватарки отдаются без подписи: имя файла случайное, а фото видно всем в ленте и профилях.
const avatarPrefix = "avatars/"

func (s *Server) avatarURL(key string) string { return s.ext.Media.Signer.Base + "/" + key }

// ownAvatarKey — ключ файла, если photo_url указывает на нашу загруженную аватарку.
func (s *Server) ownAvatarKey(photoURL string) string {
	prefix := s.ext.Media.Signer.Base + "/" + avatarPrefix
	if strings.HasPrefix(photoURL, prefix) {
		return strings.TrimPrefix(photoURL, s.ext.Media.Signer.Base+"/")
	}
	return ""
}

func (s *Server) handleUploadAvatar(w http.ResponseWriter, r *http.Request, u profile.User) {
	if !s.uploadAllowed(w, u) {
		return
	}
	_, raw, ok := s.readUpload(w, r, 15<<20)
	if !ok {
		return
	}
	defer s.ext.Media.Storage.Remove(raw)
	in, _ := s.ext.Media.Storage.Path(raw)
	key := media.NewKey("avatars", ".jpg")
	out, err := s.ext.Media.Storage.Prepare(key)
	if err == nil {
		err = s.ext.Media.FF.Avatar(r.Context(), in, out)
	}
	if err != nil {
		s.ext.Media.Storage.Remove(key)
		s.log.Warn("avatar", "err", err)
		writeError(w, http.StatusBadRequest, "bad_image", "Не получилось прочитать фото. Попробуй другое")
		return
	}
	old := ""
	updated, err := s.users.Update(r.Context(), u.ID, func(c *profile.User) error {
		old = c.PhotoURL
		c.PhotoURL = s.avatarURL(key)
		return nil
	})
	if err != nil {
		s.ext.Media.Storage.Remove(key)
		s.internal(w, "save avatar", err)
		return
	}
	if k := s.ownAvatarKey(old); k != "" {
		s.ext.Media.Storage.Remove(k)
	}
	writeJSON(w, http.StatusOK, updated.Me(s.now()))
}

func (s *Server) handleDeleteAvatar(w http.ResponseWriter, r *http.Request, u profile.User) {
	old := ""
	updated, err := s.users.Update(r.Context(), u.ID, func(c *profile.User) error {
		old = c.PhotoURL
		c.PhotoURL = ""
		return nil
	})
	if err != nil {
		s.internal(w, "delete avatar", err)
		return
	}
	if k := s.ownAvatarKey(old); k != "" {
		s.ext.Media.Storage.Remove(k)
	}
	writeJSON(w, http.StatusOK, updated.Me(s.now()))
}
