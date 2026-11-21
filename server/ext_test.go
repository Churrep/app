package server

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"music/likes"
	"music/media"
	"music/tracks"
	"music/videos"
)

// testExtensions — без FFmpeg (загрузки отвечают 503), остальное работает на настоящей базе.
func testExtensions(t *testing.T, pool *pgxpool.Pool) *Extensions {
	st, err := media.NewStorage(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ff := media.FFmpeg{Bin: "ffmpeg-missing-for-tests"}
	m := &media.Media{
		Storage: st,
		Signer:  &media.Signer{Secret: []byte("test"), Base: "/api/media", TTL: time.Hour, Now: time.Now},
		FF:      ff,
		Queue:   media.NewQueue(1, slog.New(slog.NewTextHandler(io.Discard, nil))),
		FFErr:   ff.Check(),
	}
	return &Extensions{Media: m, Videos: videos.NewService(pool, m), Tracks: tracks.NewService(pool, m), Likes: likes.NewService(pool)}
}

func requireDB(t *testing.T) (*Server, *fakeSMS, *pgxpool.Pool) {
	t.Helper()
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("нужен TEST_DATABASE_URL")
	}
	s, sms := newTestServer(t)
	p, err := pgxpool.New(context.Background(), os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(p.Close)
	return s, sms, p
}

func dbExec(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
		t.Fatal(err)
	}
}

func TestMediaLinks(t *testing.T) {
	s, _, _ := requireDB(t)
	if _, err := s.ext.Media.Storage.Save("videos/x.mp4", strings.NewReader("0123456789")); err != nil {
		t.Fatal(err)
	}
	u := strings.TrimPrefix(s.url("videos/x.mp4"), "/api")

	req := httptest.NewRequest("GET", u, nil)
	req.Header.Set("Range", "bytes=2-4")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Body.String() != "234" || rec.Header().Get("Content-Type") != "video/mp4" {
		t.Fatalf("range: %d %q %s", rec.Code, rec.Body.String(), rec.Header().Get("Content-Type"))
	}
	expect(t, do(s, "GET", strings.Replace(u, "sig=", "sig=x", 1), "", nil), 403, "bad_link")
	// Путь с .. ServeMux нормализует и уводит за пределы /media — файл не отдаётся.
	if rec := do(s, "GET", "/media/videos/../../etc/passwd.mp4?exp=9999999999&sig=x", "", nil); rec.Code == 200 {
		t.Fatal("path traversal must not be served")
	}
}

func TestUploadWithoutFFmpeg(t *testing.T) {
	s, sms, _ := requireDB(t)
	c, _ := login(t, s, sms, "89274440002")
	expect(t, do(s, "PATCH", "/me", fullProfile, c), 200, "")

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("type", "video")
	mw.WriteField("tag", "own")
	fw, _ := mw.CreateFormFile("file", "take.webm")
	fw.Write([]byte("not really a video"))
	mw.Close()

	req := httptest.NewRequest("POST", "/videos", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.AddCookie(c)
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	// Без X-Upload multipart не принимается вообще (защита от CSRF).
	expect(t, rec, 415, "json_required")

	body.Reset()
	mw = multipart.NewWriter(&body)
	fw, _ = mw.CreateFormFile("file", "take.webm")
	fw.Write([]byte("x"))
	mw.Close()
	req = httptest.NewRequest("POST", "/videos", &body)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("X-Upload", "1")
	req.AddCookie(c)
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	expect(t, rec, 503, "media_unavailable")
}

func TestFeedAndVideos(t *testing.T) {
	s, sms, pool := requireDB(t)
	viewer, _ := login(t, s, sms, "89274440003")
	expect(t, do(s, "PATCH", "/me", fullProfile, viewer), 200, "")
	author, authorID := login(t, s, sms, "89274440004")
	expect(t, do(s, "PATCH", "/me", strings.Replace(fullProfile, `"bass","is_main":true},{"id":"guitar"}`, `"drums","is_main":true}`, 1), author), 200, "")

	dbExec(t, pool, `INSERT INTO videos (id, user_id, type, tag, media_key, poster_key, status, recorded_at, peaks)
		VALUES ('11111111-1111-4111-8111-111111111111', $1, 'video', 'own', 'videos/a.mp4', 'posters/a.jpg', 'ready', now(), '[0.5,1]'),
		       ('22222222-2222-4222-8222-222222222222', $1, 'audio', 'improv', 'audio/b.m4a', '', 'processing', now(), '[]')`, authorID)

	rec := do(s, "GET", "/feed", "", viewer)
	expect(t, rec, 200, "")
	items := jsonBody(t, rec)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("feed: want 1 ready video, got %d", len(items))
	}
	it := items[0].(map[string]any)
	if it["author"].(map[string]any)["main_instrument"] != "drums" || !strings.HasPrefix(it["video"].(map[string]any)["media_url"].(string), "/api/media/videos/a.mp4?") {
		t.Fatalf("feed item: %v", it)
	}
	if n := len(jsonBody(t, do(s, "GET", "/feed?instrument=keys", "", viewer))["items"].([]any)); n != 0 {
		t.Fatalf("filter by instrument: got %d", n)
	}
	if n := len(jsonBody(t, do(s, "GET", "/feed", "", author))["items"].([]any)); n != 0 {
		t.Fatal("own videos must not be in own feed")
	}

	// Чужие видят только готовые, автор — все.
	if n := len(jsonBody(t, do(s, "GET", "/users/"+authorID+"/videos", "", viewer))["items"].([]any)); n != 1 {
		t.Fatalf("public videos: %d", n)
	}
	if n := len(jsonBody(t, do(s, "GET", "/me/videos", "", author))["items"].([]any)); n != 2 {
		t.Fatalf("own videos: %d", n)
	}

	expect(t, do(s, "PATCH", "/videos/11111111-1111-4111-8111-111111111111", `{"is_pinned":true}`, viewer), 404, "not_found")
	expect(t, do(s, "PATCH", "/videos/22222222-2222-4222-8222-222222222222", `{"is_pinned":true}`, author), 409, "not_ready")
	rec = do(s, "PATCH", "/videos/11111111-1111-4111-8111-111111111111", `{"is_pinned":true,"caption":"  живьём "}`, author)
	expect(t, rec, 200, "")
	if b := jsonBody(t, rec); b["is_pinned"] != true || b["caption"] != "живьём" {
		t.Fatalf("patch: %v", b)
	}
	expect(t, do(s, "DELETE", "/videos/11111111-1111-4111-8111-111111111111", `{}`, author), 204, "")
	if n := len(jsonBody(t, do(s, "GET", "/feed", "", viewer))["items"].([]any)); n != 0 {
		t.Fatal("deleted video must leave the feed")
	}
}

func TestBandsSpotsResponses(t *testing.T) {
	s, sms, pool := requireDB(t)
	leader, leaderID := login(t, s, sms, "89274440005")
	expect(t, do(s, "PATCH", "/me", strings.Replace(fullProfile, `"bass","is_main":true},{"id":"guitar"}`, `"vocals","is_main":true}`, 1), leader), 200, "")
	bassist, bassistID := login(t, s, sms, "89274440006")
	expect(t, do(s, "PATCH", "/me", fullProfile, bassist), 200, "")

	expect(t, do(s, "POST", "/bands", `{"name":"  "}`, leader), 400, "invalid")
	rec := do(s, "POST", "/bands", `{"name":"Сквозняк","genres":["rock"]}`, leader)
	expect(t, rec, 201, "")
	bandID := jsonBody(t, rec)["id"].(string)
	if n := len(jsonBody(t, do(s, "GET", "/me/bands", "", leader))["items"].([]any)); n != 1 {
		t.Fatal("band must be in my bands")
	}

	spotID := "33333333-3333-4333-8333-333333333333"
	dbExec(t, pool, `INSERT INTO open_spots (id, band_id, instrument_id, song_title, backing_key, backing_duration_ms, bpm, key, genre_id,
		own_song_confirmed, status, created_by) VALUES ($1, $2, 'bass', 'Дождь', 'backing/x.m4a', 180000, 120, 'Am', 'rock', true, 'open', $3)`,
		spotID, bandID, leaderID)
	dbExec(t, pool, `INSERT INTO spot_stems (spot_id, position, instrument_id, stem_key, peaks, duration_ms) VALUES
		($1, 1, 'guitar', 'stems/g.m4a', '[0.5]', 180000), ($1, 2, 'drums', 'stems/d.m4a', '[]', 179000), ($1, 3, 'keys', '', '[]', 0)`, spotID)

	// Карточка места отдаёт обработанные дорожки по порядку, список мест — без дорожек.
	rec = do(s, "GET", "/spots/"+spotID, "", bassist)
	expect(t, rec, 200, "")
	stems, _ := jsonBody(t, rec)["stems"].([]any)
	if len(stems) != 2 || stems[0].(map[string]any)["instrument_id"] != "guitar" || stems[0].(map[string]any)["url"] == "" ||
		stems[1].(map[string]any)["instrument_id"] != "drums" {
		t.Fatalf("stems: %v", stems)
	}
	if _, ok := jsonBody(t, do(s, "GET", "/spots", "", bassist))["items"].([]any)[0].(map[string]any)["stems"]; ok {
		t.Fatal("spot list must not include stems")
	}

	// Басист видит место, лидер — нет (это его группа), но видит в «Мои места».
	if n := len(jsonBody(t, do(s, "GET", "/spots", "", bassist))["items"].([]any)); n != 1 {
		t.Fatalf("open spots for bassist: %d", n)
	}
	if n := len(jsonBody(t, do(s, "GET", "/spots", "", leader))["items"].([]any)); n != 0 {
		t.Fatal("own band spots must not be in open list")
	}
	if n := len(jsonBody(t, do(s, "GET", "/spots?scope=mine", "", leader))["items"].([]any)); n != 1 {
		t.Fatal("spot must be in my spots")
	}

	respID := "44444444-4444-4444-8444-444444444444"
	dbExec(t, pool, `INSERT INTO spot_responses (id, spot_id, user_id, track_key, mix_key, status) VALUES ($1, $2, $3, 'tracks/t.m4a', 'mixes/m.m4a', 'sent')`,
		respID, spotID, bassistID)

	expect(t, do(s, "GET", "/spots/"+spotID+"/responses", "", bassist), 403, "forbidden")
	rec = do(s, "GET", "/spots/"+spotID+"/responses", "", leader)
	expect(t, rec, 200, "")
	items := jsonBody(t, rec)["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["author"].(map[string]any)["id"] != bassistID {
		t.Fatalf("responses: %v", items)
	}

	expect(t, do(s, "PATCH", "/responses/"+respID, `{"status":"invited"}`, bassist), 403, "forbidden")
	expect(t, do(s, "PATCH", "/responses/"+respID, `{"status":"invited"}`, leader), 200, "")
	expect(t, do(s, "PATCH", "/responses/"+respID, `{"status":"rejected"}`, leader), 409, "already_answered")

	rec = do(s, "GET", "/me/responses", "", bassist)
	expect(t, rec, 200, "")
	mine := jsonBody(t, rec)["items"].([]any)[0].(map[string]any)
	if mine["status"] != "invited" || mine["spot"].(map[string]any)["band"].(map[string]any)["name"] != "Сквозняк" {
		t.Fatalf("my responses: %v", mine)
	}

	expect(t, do(s, "POST", "/spots/"+spotID+"/close", `{}`, bassist), 403, "forbidden")
	rec = do(s, "POST", "/spots/"+spotID+"/close", `{}`, leader)
	expect(t, rec, 200, "")
	if jsonBody(t, rec)["status"] != "closed" {
		t.Fatal("spot must be closed")
	}
}

func TestVideoLikesAndInvites(t *testing.T) {
	s, sms, pool := requireDB(t)
	anya, anyaID := login(t, s, sms, "89275550001")
	expect(t, do(s, "PATCH", "/me", fullProfile, anya), 200, "")
	boris, borisID := login(t, s, sms, "89275550002")
	expect(t, do(s, "PATCH", "/me", fullProfile, boris), 200, "")
	const v1, v2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	dbExec(t, pool, `INSERT INTO videos (id, user_id, type, tag, media_key, status, recorded_at, created_at) VALUES
		($2, $1, 'video', 'own', 'videos/1.mp4', 'ready', now(), now() - interval '1 hour'),
		($3, $1, 'video', 'own', 'videos/2.mp4', 'ready', now(), now())`, borisID, v1, v2)

	feedLiked := func(c *http.Cookie) map[string]bool {
		out := map[string]bool{}
		for _, it := range jsonBody(t, do(s, "GET", "/feed", "", c))["items"].([]any) {
			m := it.(map[string]any)
			out[m["video"].(map[string]any)["id"].(string)] = m["liked"].(bool)
		}
		return out
	}
	incoming := func(c *http.Cookie) int {
		return int(jsonBody(t, do(s, "GET", "/invites/incoming/count", "", c))["count"].(float64))
	}

	// Аня лайкает обе записи Бориса и снимает один лайк. Записи остаются в ленте.
	expect(t, do(s, "POST", "/videos/"+v1+"/like", `{}`, anya), 204, "")
	expect(t, do(s, "POST", "/videos/"+v2+"/like", `{}`, anya), 204, "")
	expect(t, do(s, "POST", "/videos/"+v2+"/like", `{}`, anya), 204, "") // повтор ничего не меняет
	expect(t, do(s, "DELETE", "/videos/"+v1+"/like", `{}`, anya), 204, "")
	if f := feedLiked(anya); len(f) != 2 || f[v1] || !f[v2] {
		t.Fatalf("feed after likes: %v", f)
	}
	expect(t, do(s, "POST", "/videos/"+v1+"/like", `{}`, boris), 400, "invalid") // свою — нельзя
	expect(t, do(s, "POST", "/videos/cccccccc-cccc-4ccc-8ccc-cccccccccccc/like", `{}`, anya), 404, "not_found")

	// Борис видит, кто лайкнул его записи; Аня своих входящих лайков не получает.
	likes := jsonBody(t, do(s, "GET", "/likes/incoming", "", boris))["items"].([]any)
	if len(likes) != 1 || likes[0].(map[string]any)["author"].(map[string]any)["id"] != anyaID ||
		likes[0].(map[string]any)["video"].(map[string]any)["id"] != v2 {
		t.Fatalf("incoming likes: %v", likes)
	}
	if n := len(jsonBody(t, do(s, "GET", "/likes/incoming", "", anya))["items"].([]any)); n != 0 {
		t.Fatalf("anya has no incoming likes: %d", n)
	}
	// В профиле Бориса у Ани отмечена лайкнутая запись.
	for _, it := range jsonBody(t, do(s, "GET", "/users/"+borisID+"/videos", "", anya))["items"].([]any) {
		m := it.(map[string]any)
		if m["liked"] != (m["id"] == v2) {
			t.Fatalf("user videos liked flags: %v", m)
		}
	}

	// Лайки записей предложений не создают.
	if n := incoming(boris); n != 0 {
		t.Fatalf("video likes must not create invites: %d", n)
	}
	if r := jsonBody(t, do(s, "GET", "/users/"+borisID+"/relation", "", anya)); r["invited"] != false || r["mutual"] != false {
		t.Fatalf("relation before invite: %v", r)
	}

	// Предложение — отдельное действие. Входящее у Бориса появляется только после него.
	expect(t, do(s, "POST", "/invites", `{"to_user_id":"`+anyaID+`"}`, anya), 400, "invalid") // себе — нельзя
	rec := do(s, "POST", "/invites", `{"to_user_id":"`+borisID+`"}`, anya)
	expect(t, rec, 200, "")
	if jsonBody(t, rec)["mutual"] != false {
		t.Fatal("one-sided invite must not be mutual")
	}
	expect(t, do(s, "POST", "/invites", `{"to_user_id":"`+borisID+`"}`, anya), 200, "") // без дублей
	if n := incoming(boris); n != 1 {
		t.Fatalf("incoming for boris: %d", n)
	}
	items := jsonBody(t, do(s, "GET", "/invites/incoming", "", boris))["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["author"].(map[string]any)["id"] != anyaID {
		t.Fatalf("incoming: %v", items)
	}
	if r := jsonBody(t, do(s, "GET", "/users/"+anyaID+"/relation", "", boris)); r["invited_me"] != true || r["invited"] != false {
		t.Fatalf("relation for boris: %v", r)
	}
	// Снятие лайка записи предложение не трогает.
	expect(t, do(s, "DELETE", "/videos/"+v2+"/like", `{}`, anya), 204, "")
	if n := incoming(boris); n != 1 {
		t.Fatal("unlike must not touch the invite")
	}

	// «Не сейчас» скрывает, но ответное предложение всё равно даёт взаимность.
	expect(t, do(s, "POST", "/invites/incoming/"+anyaID+"/dismiss", `{}`, boris), 204, "")
	if n := incoming(boris); n != 0 {
		t.Fatal("dismissed invite must be hidden")
	}
	rec = do(s, "POST", "/invites", `{"to_user_id":"`+anyaID+`"}`, boris)
	expect(t, rec, 200, "")
	if jsonBody(t, rec)["mutual"] != true {
		t.Fatal("two invites must be mutual")
	}
	for _, c := range []struct {
		cookie  *http.Cookie
		otherID string
	}{{anya, borisID}, {boris, anyaID}} {
		ms := jsonBody(t, do(s, "GET", "/matches", "", c.cookie))["items"].([]any)
		if len(ms) != 1 || ms[0].(map[string]any)["other"].(map[string]any)["id"] != c.otherID {
			t.Fatalf("matches: %v", ms)
		}
	}
	if r := jsonBody(t, do(s, "GET", "/users/"+borisID+"/relation", "", anya)); r["mutual"] != true {
		t.Fatalf("relation after mutual: %v", r)
	}
	expect(t, do(s, "DELETE", "/invites/"+borisID, `{}`, anya), 409, "matched")

	// Третий: предложение можно отменить, пока нет взаимности.
	vera, _ := login(t, s, sms, "89275550003")
	expect(t, do(s, "PATCH", "/me", fullProfile, vera), 200, "")
	expect(t, do(s, "POST", "/invites", `{"to_user_id":"`+borisID+`"}`, vera), 200, "")
	expect(t, do(s, "DELETE", "/invites/"+borisID, `{}`, vera), 204, "")
	if r := jsonBody(t, do(s, "GET", "/users/"+borisID+"/relation", "", vera)); r["invited"] != false {
		t.Fatal("withdraw must remove invite")
	}
	if n := len(jsonBody(t, do(s, "GET", "/matches", "", vera))["items"].([]any)); n != 0 {
		t.Fatal("vera has no matches")
	}
}

// Два встречных предложения одновременно: у каждого ровно одно совпадение, и хотя бы один ответ — «взаимно».
func TestInvitesConcurrent(t *testing.T) {
	s, sms, _ := requireDB(t)
	a, aID := login(t, s, sms, "89275550011")
	expect(t, do(s, "PATCH", "/me", fullProfile, a), 200, "")
	b, bID := login(t, s, sms, "89275550012")
	expect(t, do(s, "PATCH", "/me", fullProfile, b), 200, "")

	var wg sync.WaitGroup
	results := make([]map[string]any, 2)
	for i, p := range []struct {
		c  *http.Cookie
		to string
	}{{a, bID}, {b, aID}} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := do(s, "POST", "/invites", `{"to_user_id":"`+p.to+`"}`, p.c)
			if rec.Code != 200 {
				t.Errorf("invite %d: %d %s", i, rec.Code, rec.Body.String())
				return
			}
			results[i] = jsonBody(t, rec)
		}()
	}
	wg.Wait()
	if results[0] == nil || results[1] == nil {
		t.FailNow()
	}
	if results[0]["mutual"] != true && results[1]["mutual"] != true {
		t.Fatalf("one of the concurrent invites must see mutual: %v", results)
	}
	for _, c := range []*http.Cookie{a, b} {
		if n := len(jsonBody(t, do(s, "GET", "/matches", "", c))["items"].([]any)); n != 1 {
			t.Fatalf("matches after concurrent invites: %d", n)
		}
	}
}

func TestAvatarPublicAndSpotsForAll(t *testing.T) {
	s, sms, pool := requireDB(t)
	if _, err := s.ext.Media.Storage.Save("avatars/abc.jpg", strings.NewReader("jpg")); err != nil {
		t.Fatal(err)
	}
	rec := do(s, "GET", "/media/avatars/abc.jpg", "", nil)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("avatar must be public: %d", rec.Code)
	}
	expect(t, do(s, "GET", "/media/videos/abc.mp4", "", nil), 403, "bad_link")

	// Места видны всем, сначала — под мои инструменты.
	leader, leaderID := login(t, s, sms, "89276660001")
	expect(t, do(s, "PATCH", "/me", fullProfile, leader), 200, "")
	rec = do(s, "POST", "/bands", `{"name":"Группа"}`, leader)
	bandID := jsonBody(t, rec)["id"].(string)
	dbExec(t, pool, `INSERT INTO open_spots (id, band_id, instrument_id, bpm, genre_id, own_song_confirmed, status, created_by, created_at) VALUES
		('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $1, 'drums', 100, 'rock', true, 'open', $2, now()),
		('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', $1, 'bass', 100, 'rock', true, 'open', $2, now() - interval '1 hour')`, bandID, leaderID)
	guitarist, _ := login(t, s, sms, "89276660002")
	expect(t, do(s, "PATCH", "/me", strings.Replace(fullProfile, `"bass","is_main":true},{"id":"guitar"}`, `"bass","is_main":true}`, 1), guitarist), 200, "")
	items := jsonBody(t, do(s, "GET", "/spots", "", guitarist))["items"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["instrument_id"] != "bass" {
		t.Fatalf("want both spots, bass first: %v", items)
	}
	if n := len(jsonBody(t, do(s, "GET", "/spots?instrument=drums", "", guitarist))["items"].([]any)); n != 1 {
		t.Fatalf("instrument filter: %d", n)
	}
}
