package server

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"music/media"
	"music/profile"
	"music/tracks"
	"music/videos"
)

func (s *Server) routesExt(m *http.ServeMux) {
	m.HandleFunc("GET /media/{key...}", s.withExt(s.handleMedia))

	m.HandleFunc("POST /me/photo", s.withExt(s.withUser(s.handleUploadAvatar)))
	m.HandleFunc("DELETE /me/photo", s.withExt(s.withUser(s.handleDeleteAvatar)))

	m.HandleFunc("GET /feed", s.withExt(s.withOnboarded(s.handleFeed)))
	m.HandleFunc("POST /videos", s.withExt(s.withOnboarded(s.handleCreateVideo)))
	m.HandleFunc("GET /videos/{id}", s.withExt(s.withOnboarded(s.handleGetVideo)))
	m.HandleFunc("PATCH /videos/{id}", s.withExt(s.withOnboarded(s.handlePatchVideo)))
	m.HandleFunc("DELETE /videos/{id}", s.withExt(s.withOnboarded(s.handleDeleteVideo)))
	m.HandleFunc("GET /me/videos", s.withExt(s.withUser(s.handleMyVideos)))
	m.HandleFunc("GET /users/{id}/videos", s.withExt(s.withOnboarded(s.handleUserVideos)))

	m.HandleFunc("POST /bands", s.withExt(s.withOnboarded(s.handleCreateBand)))
	m.HandleFunc("GET /me/bands", s.withExt(s.withOnboarded(s.handleMyBands)))
	m.HandleFunc("GET /spots", s.withExt(s.withOnboarded(s.handleListSpots)))
	m.HandleFunc("POST /spots", s.withExt(s.withOnboarded(s.handleCreateSpot)))
	m.HandleFunc("GET /spots/{id}", s.withExt(s.withOnboarded(s.handleGetSpot)))
	m.HandleFunc("POST /spots/{id}/close", s.withExt(s.withOnboarded(s.handleCloseSpot)))
	m.HandleFunc("POST /spots/{id}/responses", s.withExt(s.withOnboarded(s.handleCreateResponse)))
	m.HandleFunc("GET /spots/{id}/responses", s.withExt(s.withOnboarded(s.handleListResponses)))
	m.HandleFunc("PATCH /responses/{id}", s.withExt(s.withOnboarded(s.handlePatchResponse)))
	m.HandleFunc("GET /me/responses", s.withExt(s.withOnboarded(s.handleMyResponses)))

	s.routesLikes(m)
}

func (s *Server) withExt(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.ext == nil {
			writeError(w, http.StatusServiceUnavailable, "needs_database", "Эта функция работает только с базой данных")
			return
		}
		h(w, r)
	}
}

func (s *Server) withOnboarded(h userHandler) http.HandlerFunc {
	return s.withUser(func(w http.ResponseWriter, r *http.Request, u profile.User) {
		if !u.Onboarding().Complete {
			writeError(w, http.StatusForbidden, "onboarding_required", "Сначала закончи анкету")
			return
		}
		h(w, r, u)
	})
}

// ---------- Файлы ----------

var mediaTypes = map[string]string{".mp4": "video/mp4", ".m4a": "audio/mp4", ".jpg": "image/jpeg"}

func (s *Server) handleMedia(w http.ResponseWriter, r *http.Request) {
	key := r.PathValue("key")
	q := r.URL.Query()
	ct, ok := mediaTypes[path.Ext(key)]
	public := strings.HasPrefix(key, avatarPrefix) && !strings.Contains(key[len(avatarPrefix):], "/")
	if !ok || !public && !s.ext.Media.Signer.Verify(key, q.Get("exp"), q.Get("sig")) {
		writeError(w, http.StatusForbidden, "bad_link", "Ссылка устарела. Обнови страницу")
		return
	}
	p, err := s.ext.Media.Storage.Path(key)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Файл не найден")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Файл не найден")
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		s.internal(w, "stat media", err)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "", st.ModTime(), f) // поддерживает Range — нужно для перемотки видео
}

func (s *Server) url(key string) string { return s.ext.Media.Signer.URL(key) }

// readUpload читает multipart: поле file сохраняется в хранилище как сырой файл, остальные поля — в map.
func (s *Server) readUpload(w http.ResponseWriter, r *http.Request, maxBytes int64) (map[string]string, string, bool) {
	fields, files, ok := s.readUploadFiles(w, r, maxBytes, maxBytes, func(name string) bool { return name == "file" })
	if !ok {
		return nil, "", false
	}
	if files["file"] == "" {
		writeError(w, http.StatusBadRequest, "no_file", "Файл не пришёл. Попробуй ещё раз")
		return nil, "", false
	}
	return fields, files["file"], true
}

// readUploadFiles читает multipart с несколькими файлами. Части-файлы, для которых isFile(имя поля) верно,
// сохраняются в хранилище как сырые файлы (имя поля → ключ), остальные поля — в fields.
// maxBytes ограничивает весь запрос, maxFileBytes — каждый файл. При ошибке сохранённые файлы удаляются.
func (s *Server) readUploadFiles(w http.ResponseWriter, r *http.Request, maxBytes, maxFileBytes int64, isFile func(string) bool) (map[string]string, map[string]string, bool) {
	if r.Header.Get("X-Upload") != "1" {
		writeError(w, http.StatusUnsupportedMediaType, "upload_required", "Нужна загрузка файла")
		return nil, nil, false
	}
	if err := s.ext.Media.FFErr; err != nil {
		s.log.Error("upload without ffmpeg", "err", err)
		writeError(w, http.StatusServiceUnavailable, "media_unavailable", "Обработка записей временно не работает. Попробуй позже")
		return nil, nil, false
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_upload", "Не получилось прочитать файл")
		return nil, nil, false
	}
	fields := map[string]string{}
	files := map[string]string{}
	fail := func(status int, code, msg string) (map[string]string, map[string]string, bool) {
		for _, k := range files {
			s.ext.Media.Storage.Remove(k)
		}
		writeError(w, status, code, msg)
		return nil, nil, false
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				return fail(http.StatusRequestEntityTooLarge, "too_large", "Файл слишком большой")
			}
			return fail(http.StatusBadRequest, "bad_upload", "Загрузка оборвалась. Попробуй ещё раз")
		}
		if name := part.FormName(); isFile(name) && part.FileName() != "" {
			if files[name] != "" {
				return fail(http.StatusBadRequest, "bad_upload", "Нужен один файл")
			}
			key := media.NewKey("raw", "")
			files[name] = key
			n, err := s.ext.Media.Storage.Save(key, io.LimitReader(part, maxFileBytes+1))
			if err != nil {
				var tooBig *http.MaxBytesError
				if errors.As(err, &tooBig) {
					return fail(http.StatusRequestEntityTooLarge, "too_large", "Файл слишком большой")
				}
				return fail(http.StatusBadRequest, "bad_upload", "Загрузка оборвалась. Попробуй ещё раз")
			}
			if n > maxFileBytes {
				return fail(http.StatusRequestEntityTooLarge, "too_large", "Файл слишком большой")
			}
			continue
		}
		b, err := io.ReadAll(io.LimitReader(part, 4096))
		if err != nil {
			return fail(http.StatusBadRequest, "bad_upload", "Загрузка оборвалась. Попробуй ещё раз")
		}
		fields[part.FormName()] = string(b)
	}
	return fields, files, true
}

func (s *Server) uploadAllowed(w http.ResponseWriter, u profile.User) bool {
	if !s.uploadLimiter.allow(u.ID, s.now()) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "Слишком много загрузок. Попробуй через час")
		return false
	}
	return true
}

// ---------- Видео и лента ----------

type videoView struct {
	ID         string    `json:"id"`
	Type       string    `json:"type"`
	Tag        string    `json:"tag"`
	Caption    string    `json:"caption"`
	DurationMS int       `json:"duration_ms"`
	MediaURL   string    `json:"media_url"`
	PosterURL  string    `json:"poster_url"`
	Peaks      []float64 `json:"peaks"`
	IsPinned   bool      `json:"is_pinned"`
	Status     string    `json:"status"`
	Error      string    `json:"error,omitempty"`
	RecordedAt time.Time `json:"recorded_at"`
	CreatedAt  time.Time `json:"created_at"`
}

func (s *Server) videoView(v videos.Video) videoView {
	return videoView{v.ID, v.Type, v.Tag, v.Caption, v.DurationMS, s.url(v.MediaKey), s.url(v.PosterKey), v.Peaks,
		v.IsPinned, v.Status, v.Error, v.RecordedAt, v.CreatedAt}
}

func (s *Server) videoViews(list []videos.Video) []videoView {
	out := make([]videoView, len(list))
	for i, v := range list {
		out[i] = s.videoView(v)
	}
	return out
}

func (s *Server) handleCreateVideo(w http.ResponseWriter, r *http.Request, u profile.User) {
	if !s.uploadAllowed(w, u) {
		return
	}
	fields, key, ok := s.readUpload(w, r, 150<<20)
	if !ok {
		return
	}
	recorded, _ := time.Parse(time.RFC3339, fields["recorded_at"])
	v, err := s.ext.Videos.Create(r.Context(), u.ID, videos.Input{
		Type: fields["type"], Tag: fields["tag"], Caption: fields["caption"], RecordedAt: recorded,
	}, key, s.now())
	if err != nil {
		s.ext.Media.Storage.Remove(key)
		s.fail(w, "create video", err)
		return
	}
	writeJSON(w, http.StatusCreated, s.videoView(v))
}

func (s *Server) handleGetVideo(w http.ResponseWriter, r *http.Request, u profile.User) {
	id := r.PathValue("id")
	if !profile.IsUUID(id) {
		writeError(w, http.StatusNotFound, "not_found", "Запись не найдена")
		return
	}
	v, err := s.ext.Videos.Get(r.Context(), id)
	if err == nil && v.UserID != u.ID && v.Status != "ready" {
		writeError(w, http.StatusNotFound, "not_found", "Запись не найдена")
		return
	}
	if err != nil {
		s.fail(w, "get video", err)
		return
	}
	writeJSON(w, http.StatusOK, s.videoView(v))
}

func (s *Server) handlePatchVideo(w http.ResponseWriter, r *http.Request, u profile.User) {
	var req struct {
		Caption  *string `json:"caption"`
		IsPinned *bool   `json:"is_pinned"`
	}
	if !decode(w, r, &req) {
		return
	}
	id := r.PathValue("id")
	if !profile.IsUUID(id) {
		writeError(w, http.StatusNotFound, "not_found", "Запись не найдена")
		return
	}
	v, err := s.ext.Videos.Update(r.Context(), u.ID, id, req.Caption, req.IsPinned)
	if err != nil {
		s.fail(w, "update video", err)
		return
	}
	writeJSON(w, http.StatusOK, s.videoView(v))
}

func (s *Server) handleDeleteVideo(w http.ResponseWriter, r *http.Request, u profile.User) {
	id := r.PathValue("id")
	if !profile.IsUUID(id) {
		writeError(w, http.StatusNotFound, "not_found", "Запись не найдена")
		return
	}
	if err := s.ext.Videos.Delete(r.Context(), u.ID, id); err != nil {
		s.fail(w, "delete video", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMyVideos(w http.ResponseWriter, r *http.Request, u profile.User) {
	list, err := s.ext.Videos.ListByUser(r.Context(), u.ID, true)
	if err != nil {
		s.fail(w, "my videos", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": s.videoViews(list)})
}

func (s *Server) handleUserVideos(w http.ResponseWriter, r *http.Request, u profile.User) {
	id := r.PathValue("id")
	if _, err := s.users.Get(r.Context(), id); err != nil {
		writeError(w, http.StatusNotFound, "not_found", "Профиль не найден")
		return
	}
	list, err := s.ext.Videos.ListByUser(r.Context(), id, id == u.ID)
	if err != nil {
		s.fail(w, "user videos", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": s.videoViews(list)})
}

func (s *Server) handleFeed(w http.ResponseWriter, r *http.Request, u profile.User) {
	q := r.URL.Query()
	lmin, _ := strconv.Atoi(q.Get("level_min"))
	lmax, _ := strconv.Atoi(q.Get("level_max"))
	items, next, err := s.ext.Videos.Feed(r.Context(), u.ID, videos.FeedFilter{
		Instrument: q.Get("instrument"), Genre: q.Get("genre"), LookingFor: q.Get("looking_for"), LevelMin: lmin, LevelMax: lmax,
	}, q.Get("cursor"), 10, s.now())
	if err != nil {
		s.fail(w, "feed", err)
		return
	}
	type item struct {
		Video  videoView      `json:"video"`
		Author profile.Author `json:"author"`
	}
	out := make([]item, len(items))
	for i, it := range items {
		out[i] = item{s.videoView(it.Video), it.Author}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "next_cursor": next})
}

// ---------- Группы и дорожки ----------

type bandView struct {
	ID     string   `json:"id"`
	Name   string   `json:"name"`
	Genres []string `json:"genres"`
	Role   string   `json:"role"`
}

type spotView struct {
	ID                string     `json:"id"`
	Band              bandRef    `json:"band"`
	InstrumentID      string     `json:"instrument_id"`
	SongTitle         string     `json:"song_title"`
	BackingURL        string     `json:"backing_url"`
	BackingPeaks      []float64  `json:"backing_peaks"`
	BackingDurationMS int        `json:"backing_duration_ms"`
	BPM               int        `json:"bpm"`
	Key               string     `json:"key"`
	GenreID           string     `json:"genre_id"`
	Description       string     `json:"description"`
	Deadline          *string    `json:"deadline"`
	Status            string     `json:"status"` // processing / open / expired / closed / failed
	Error             string     `json:"error,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	ResponsesCount    int        `json:"responses_count"`
	IsMember          bool       `json:"is_member"`
	MyResponse        *respRef   `json:"my_response"`
	Stems             []stemView `json:"stems,omitempty"` // только в карточке места
}

type stemView struct {
	ID           string    `json:"id"`
	Position     int       `json:"position"`
	InstrumentID string    `json:"instrument_id"`
	URL          string    `json:"url"`
	Peaks        []float64 `json:"peaks"`
	DurationMS   int       `json:"duration_ms"`
}

type bandRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type respRef struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

func (s *Server) spotView(sp tracks.Spot) spotView {
	v := spotView{
		ID: sp.ID, Band: bandRef{sp.BandID, sp.BandName}, InstrumentID: sp.InstrumentID, SongTitle: sp.SongTitle,
		BackingURL: s.url(sp.BackingKey), BackingPeaks: sp.BackingPeaks, BackingDurationMS: sp.BackingDurationMS,
		BPM: sp.BPM, Key: sp.Key, GenreID: sp.GenreID, Description: sp.Description, Status: sp.Status, Error: sp.Error,
		CreatedAt: sp.CreatedAt, ResponsesCount: sp.ResponsesCount, IsMember: sp.IsMember,
	}
	if sp.Deadline != nil {
		d := sp.Deadline.Format(time.DateOnly)
		v.Deadline = &d
	}
	if sp.Status == "open" && sp.Expired(s.now()) {
		v.Status = "expired"
	}
	if sp.MyResponseID != "" {
		v.MyResponse = &respRef{sp.MyResponseID, sp.MyResponseStatus}
	}
	for _, st := range sp.Stems {
		v.Stems = append(v.Stems, stemView{st.ID, st.Position, st.InstrumentID, s.url(st.Key), st.Peaks, st.DurationMS})
	}
	return v
}

func (s *Server) spotViews(list []tracks.Spot) []spotView {
	out := make([]spotView, len(list))
	for i, sp := range list {
		out[i] = s.spotView(sp)
	}
	return out
}

type responseView struct {
	ID              string          `json:"id"`
	SpotID          string          `json:"spot_id"`
	TrackURL        string          `json:"track_url"`
	MixURL          string          `json:"mix_url"`
	TrackPeaks      []float64       `json:"track_peaks"`
	TrackDurationMS int             `json:"track_duration_ms"`
	OffsetMS        int             `json:"offset_ms"`
	StartMS         int             `json:"start_ms"`
	GainBacking     float64         `json:"gain_backing"`
	GainTrack       float64         `json:"gain_track"`
	Status          string          `json:"status"`
	Error           string          `json:"error,omitempty"`
	CreatedAt       time.Time       `json:"created_at"`
	Author          *profile.Author `json:"author,omitempty"`
	Spot            *spotView       `json:"spot,omitempty"`
}

func (s *Server) responseView(r tracks.Response) responseView {
	v := responseView{
		ID: r.ID, SpotID: r.SpotID, TrackURL: s.url(r.TrackKey), MixURL: s.url(r.MixKey), TrackPeaks: r.TrackPeaks,
		TrackDurationMS: r.TrackDurationMS, OffsetMS: r.OffsetMS, StartMS: r.StartMS, GainBacking: r.GainBacking,
		GainTrack: r.GainTrack, Status: r.Status, Error: r.Error, CreatedAt: r.CreatedAt,
	}
	if r.Author.ID != "" {
		a := r.Author
		v.Author = &a
	}
	if r.Spot != nil {
		sv := s.spotView(*r.Spot)
		v.Spot = &sv
	}
	return v
}

func (s *Server) handleCreateBand(w http.ResponseWriter, r *http.Request, u profile.User) {
	var req struct {
		Name   string   `json:"name"`
		Genres []string `json:"genres"`
	}
	if !decode(w, r, &req) {
		return
	}
	b, err := s.ext.Tracks.CreateBand(r.Context(), u.ID, req.Name, req.Genres)
	if err != nil {
		s.fail(w, "create band", err)
		return
	}
	writeJSON(w, http.StatusCreated, bandView{b.ID, b.Name, b.Genres, b.Role})
}

func (s *Server) handleMyBands(w http.ResponseWriter, r *http.Request, u profile.User) {
	list, err := s.ext.Tracks.MyBands(r.Context(), u.ID)
	if err != nil {
		s.fail(w, "my bands", err)
		return
	}
	out := make([]bandView, len(list))
	for i, b := range list {
		out[i] = bandView{b.ID, b.Name, b.Genres, b.Role}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handleListSpots(w http.ResponseWriter, r *http.Request, u profile.User) {
	var list []tracks.Spot
	var err error
	if r.URL.Query().Get("scope") == "mine" {
		list, err = s.ext.Tracks.MySpots(r.Context(), u.ID)
	} else {
		mine := make([]string, len(u.Instruments))
		for i, in := range u.Instruments {
			mine[i] = in.ID
		}
		list, err = s.ext.Tracks.ListOpen(r.Context(), u.ID, mine, r.URL.Query().Get("instrument"), s.now())
	}
	if err != nil {
		s.fail(w, "list spots", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": s.spotViews(list)})
}

// spotUploadMax — весь запрос на новое место: минус и дорожки вместе.
const spotUploadMax = 250 << 20

func (s *Server) handleCreateSpot(w http.ResponseWriter, r *http.Request, u profile.User) {
	if !s.uploadAllowed(w, u) {
		return
	}
	// file — полный минус (обязателен), stem_1…stem_8 — отдельные дорожки, stem_N_instrument — их инструменты.
	stemField := func(i int) string { return "stem_" + strconv.Itoa(i) }
	fields, files, ok := s.readUploadFiles(w, r, spotUploadMax, 50<<20, func(name string) bool {
		if name == "file" {
			return true
		}
		n, err := strconv.Atoi(strings.TrimPrefix(name, "stem_"))
		return strings.HasPrefix(name, "stem_") && err == nil && n >= 1 && n <= tracks.MaxStems && name == stemField(n)
	})
	if !ok {
		return
	}
	removeAll := func() {
		for _, k := range files {
			s.ext.Media.Storage.Remove(k)
		}
	}
	if files["file"] == "" {
		removeAll()
		writeError(w, http.StatusBadRequest, "no_file", "Загрузи полный минус")
		return
	}
	var stems []tracks.StemInput
	for i := 1; i <= tracks.MaxStems; i++ {
		if key := files[stemField(i)]; key != "" {
			stems = append(stems, tracks.StemInput{InstrumentID: fields[stemField(i)+"_instrument"], RawKey: key})
		}
	}
	bpm, _ := strconv.Atoi(fields["bpm"])
	sp, err := s.ext.Tracks.CreateSpot(r.Context(), u.ID, tracks.SpotInput{
		BandID: fields["band_id"], InstrumentID: fields["instrument_id"], SongTitle: fields["song_title"], BPM: bpm,
		Key: fields["key"], GenreID: fields["genre_id"], Description: fields["description"], Deadline: fields["deadline"],
		OwnSong: fields["own_song"] == "true", Stems: stems,
	}, files["file"], s.now())
	if err != nil {
		removeAll()
		s.fail(w, "create spot", err)
		return
	}
	writeJSON(w, http.StatusCreated, s.spotView(sp))
}

func (s *Server) handleGetSpot(w http.ResponseWriter, r *http.Request, u profile.User) {
	sp, err := s.ext.Tracks.GetSpot(r.Context(), u.ID, r.PathValue("id"))
	if err != nil {
		s.fail(w, "get spot", err)
		return
	}
	writeJSON(w, http.StatusOK, s.spotView(sp))
}

func (s *Server) handleCloseSpot(w http.ResponseWriter, r *http.Request, u profile.User) {
	sp, err := s.ext.Tracks.CloseSpot(r.Context(), u.ID, r.PathValue("id"))
	if err != nil {
		s.fail(w, "close spot", err)
		return
	}
	writeJSON(w, http.StatusOK, s.spotView(sp))
}

func (s *Server) handleCreateResponse(w http.ResponseWriter, r *http.Request, u profile.User) {
	if !s.uploadAllowed(w, u) {
		return
	}
	fields, key, ok := s.readUpload(w, r, 60<<20)
	if !ok {
		return
	}
	num := func(name string, def float64) float64 {
		if v, err := strconv.ParseFloat(fields[name], 64); err == nil {
			return v
		}
		return def
	}
	resp, err := s.ext.Tracks.CreateResponse(r.Context(), u.ID, r.PathValue("id"), tracks.ResponseInput{
		OffsetMS: int(num("offset_ms", 0)), StartMS: int(num("start_ms", 0)),
		GainBacking: num("gain_backing", 1), GainTrack: num("gain_track", 1),
	}, key, s.now())
	if err != nil {
		s.ext.Media.Storage.Remove(key)
		s.fail(w, "create response", err)
		return
	}
	writeJSON(w, http.StatusCreated, s.responseView(resp))
}

func (s *Server) handleListResponses(w http.ResponseWriter, r *http.Request, u profile.User) {
	list, err := s.ext.Tracks.ListResponses(r.Context(), u.ID, r.PathValue("id"), s.now())
	if err != nil {
		s.fail(w, "list responses", err)
		return
	}
	out := make([]responseView, len(list))
	for i, resp := range list {
		out[i] = s.responseView(resp)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handlePatchResponse(w http.ResponseWriter, r *http.Request, u profile.User) {
	var req struct {
		Status string `json:"status"`
	}
	if !decode(w, r, &req) {
		return
	}
	resp, err := s.ext.Tracks.SetResponseStatus(r.Context(), u.ID, r.PathValue("id"), req.Status)
	if err != nil {
		s.fail(w, "patch response", err)
		return
	}
	writeJSON(w, http.StatusOK, s.responseView(resp))
}

func (s *Server) handleMyResponses(w http.ResponseWriter, r *http.Request, u profile.User) {
	list, err := s.ext.Tracks.MyResponses(r.Context(), u.ID)
	if err != nil {
		s.fail(w, "my responses", err)
		return
	}
	out := make([]responseView, len(list))
	for i, resp := range list {
		out[i] = s.responseView(resp)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}
