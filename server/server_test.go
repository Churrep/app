package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	neturl "net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"music/auth"
	"music/db"
	"music/profile"
)

var testNow = time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

type fakeSMS struct {
	mu    sync.Mutex
	codes map[string]string
}

func (f *fakeSMS) Send(_ context.Context, phone, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.codes[phone] = text[len(text)-6:]
	return nil
}

// newTestServer работает с памятью, а если задан TEST_DATABASE_URL — с PostgreSQL
// (таблицы очищаются перед каждым тестом).
func newTestServer(t *testing.T) (*Server, *fakeSMS) {
	t.Helper()
	var (
		users    profile.Store     = profile.NewMemoryStore()
		sessions auth.SessionStore = auth.NewSessions()
		ext      *Extensions
	)
	if url := os.Getenv("TEST_DATABASE_URL"); url != "" {
		// Тесты очищают таблицы — не даём случайно запустить их на рабочей базе.
		if u, err := neturl.Parse(url); err != nil || !strings.HasSuffix(u.Path, "_test") {
			t.Fatal("TEST_DATABASE_URL должен указывать на отдельную базу с именем *_test")
		}
		ctx := context.Background()
		pool, err := db.Open(ctx, url)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		if err := db.Migrate(ctx, pool); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `TRUNCATE users, bands CASCADE`); err != nil {
			t.Fatal(err)
		}
		users, sessions = profile.NewPostgresStore(pool), auth.NewPostgresSessions(pool)
		ext = testExtensions(t, pool)
	}
	sms := &fakeSMS{codes: map[string]string{}}
	s := New(Config{TelegramBotToken: "test-token"}, users, auth.NewOTP(sms), sessions,
		slog.New(slog.NewTextHandler(io.Discard, nil)), ext)
	s.now = func() time.Time { return testNow }
	return s, sms
}

func do(s *Server, method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if method != http.MethodGet {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	return rec
}

func jsonBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("bad json %q: %v", rec.Body.String(), err)
	}
	return m
}

func expect(t *testing.T, rec *httptest.ResponseRecorder, status int, errCode string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status %d, want %d: %s", rec.Code, status, rec.Body.String())
	}
	if errCode != "" {
		if got := jsonBody(t, rec)["error"]; got != errCode {
			t.Fatalf("error %v, want %s", got, errCode)
		}
	}
}

func login(t *testing.T, s *Server, sms *fakeSMS, phone string) (*http.Cookie, string) {
	t.Helper()
	expect(t, do(s, "POST", "/auth/otp", `{"phone":"`+phone+`"}`, nil), 200, "")
	norm, _ := auth.NormalizePhone(phone)
	rec := do(s, "POST", "/auth/verify", `{"phone":"`+phone+`","code":"`+sms.codes[norm]+`"}`, nil)
	expect(t, rec, 200, "")
	id := jsonBody(t, rec)["user"].(map[string]any)["id"].(string)
	for _, c := range rec.Result().Cookies() {
		if c.Name == cookieName {
			if !c.HttpOnly {
				t.Fatal("cookie must be HttpOnly")
			}
			return c, id
		}
	}
	t.Fatal("no session cookie")
	return nil, ""
}

const fullProfile = `{"birth_date":"1998-03-10","consent":true,"name":"Аня","district":"Волжский",
"instruments":[{"id":"bass","is_main":true},{"id":"guitar"}],"level":3,"genres":["rock","indie"],"goals":["hobby"],"looking_for":"band"}`

func TestOnboarding(t *testing.T) {
	s, sms := newTestServer(t)
	c, _ := login(t, s, sms, "+7 (927) 123-45-67")

	rec := do(s, "GET", "/me", "", c)
	expect(t, rec, 200, "")
	if step := jsonBody(t, rec)["onboarding"].(map[string]any)["next_step"]; step != "birth_date" {
		t.Fatalf("next_step %v", step)
	}

	expect(t, do(s, "PATCH", "/me", `{"birth_date":"2012-01-01","consent":true}`, c), 400, "too_young")
	expect(t, do(s, "PATCH", "/me", `{"birth_date":"1998-03-10"}`, c), 400, "consent_required")
	expect(t, do(s, "PATCH", "/me", `{"birth_date":"1998-03-10","consent":true}`, c), 200, "")
	expect(t, do(s, "PATCH", "/me", `{"instruments":[{"id":"bass"}]}`, c), 400, "main_instrument_required")
	expect(t, do(s, "PATCH", "/me", `{"looking_for":"musician"}`, c), 400, "looking_for_instrument_required")
	expect(t, do(s, "PATCH", "/me", `{"unknown":1}`, c), 400, "bad_json")

	rec = do(s, "PATCH", "/me", fullProfile, c)
	expect(t, rec, 200, "")
	if !jsonBody(t, rec)["onboarding"].(map[string]any)["complete"].(bool) {
		t.Fatal("onboarding should be complete")
	}
	expect(t, do(s, "PATCH", "/me", `{"birth_date":"2000-01-01"}`, c), 400, "birth_date_locked")
}

func TestPublicProfileRules(t *testing.T) {
	s, sms := newTestServer(t)
	adult, _ := login(t, s, sms, "89271111111")
	expect(t, do(s, "PATCH", "/me", fullProfile, adult), 200, "")

	minor, minorID := login(t, s, sms, "89272222222")
	minorProfile := strings.Replace(fullProfile, "1998-03-10", "2009-06-01", 1)
	expect(t, do(s, "PATCH", "/me", minorProfile, minor), 200, "")

	rec := do(s, "GET", "/users/"+minorID, "", adult)
	expect(t, rec, 200, "")
	body := jsonBody(t, rec)
	if _, ok := body["district"]; ok {
		t.Fatal("district of a minor must be hidden")
	}
	if _, ok := body["age"]; ok {
		t.Fatal("age must be hidden by default")
	}
	if body["dm_restricted"] != true {
		t.Fatal("DMs between adult and minor must be restricted")
	}

	newbie, _ := login(t, s, sms, "89273333333")
	expect(t, do(s, "GET", "/users/"+minorID, "", newbie), 403, "onboarding_required")
	expect(t, do(s, "GET", "/users/"+minorID, "", nil), 401, "unauthorized")

	expect(t, do(s, "POST", "/auth/logout", `{}`, adult), 204, "")
	expect(t, do(s, "GET", "/me", "", adult), 401, "unauthorized")
}

func TestOTPErrors(t *testing.T) {
	s, sms := newTestServer(t)
	expect(t, do(s, "POST", "/auth/otp", `{"phone":"12345"}`, nil), 400, "bad_phone")
	expect(t, do(s, "POST", "/auth/otp", `{"phone":"89270000000"}`, nil), 200, "")
	expect(t, do(s, "POST", "/auth/otp", `{"phone":"89270000000"}`, nil), 429, "too_soon")

	wrong := "000000"
	if sms.codes["+79270000000"] == wrong {
		wrong = "111111"
	}
	expect(t, do(s, "POST", "/auth/verify", `{"phone":"89270000000","code":"`+wrong+`"}`, nil), 400, "wrong_code")
	expect(t, do(s, "POST", "/auth/verify", `{"phone":"89270000000","code":"`+sms.codes["+79270000000"]+`"}`, nil), 200, "")
	// Код одноразовый.
	expect(t, do(s, "POST", "/auth/verify", `{"phone":"89270000000","code":"`+sms.codes["+79270000000"]+`"}`, nil), 400, "code_expired")
}

func TestJSONRequired(t *testing.T) {
	s, _ := newTestServer(t)
	req := httptest.NewRequest("POST", "/auth/otp", strings.NewReader("phone=89270000000"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	expect(t, rec, 415, "json_required")
}

func TestTelegramLogin(t *testing.T) {
	s, _ := newTestServer(t)
	authDate := testNow.Unix()
	dcs := fmt.Sprintf("auth_date=%d\nfirst_name=Петя\nid=12345\nusername=petya", authDate)
	secret := sha256.Sum256([]byte("test-token"))
	mac := hmac.New(sha256.New, secret[:])
	mac.Write([]byte(dcs))
	hash := hex.EncodeToString(mac.Sum(nil))

	body := fmt.Sprintf(`{"id":12345,"first_name":"Петя","username":"petya","auth_date":%d,"hash":"%s"}`, authDate, hash)
	rec := do(s, "POST", "/auth/telegram", body, nil)
	expect(t, rec, 200, "")
	if jsonBody(t, rec)["user"].(map[string]any)["name"] != "Петя" {
		t.Fatal("name should come from Telegram")
	}

	tampered := strings.Replace(body, "12345", "99999", 1)
	expect(t, do(s, "POST", "/auth/telegram", tampered, nil), 401, "telegram_invalid")
}
