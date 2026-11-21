package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSMSRu(t *testing.T) {
	var got string
	reply := `{"status":"OK","status_code":100,"sms":{"79271234567":{"status":"OK","status_code":100,"sms_id":"1"}}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		got = r.Form.Encode()
		w.Write([]byte(reply))
	}))
	defer srv.Close()

	s := SMSRu{APIID: "key", Test: true, URL: srv.URL}
	if err := s.Send(context.Background(), "+79271234567", "Код для входа: 123456"); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"api_id=key", "to=79271234567", "test=1", "json=1"} {
		if !strings.Contains(got, want) {
			t.Errorf("request %q has no %q", got, want)
		}
	}

	reply = `{"status":"OK","status_code":100,"sms":{"79271234567":{"status":"ERROR","status_code":207,"status_text":"На этот номер нельзя"}}}`
	if err := s.Send(context.Background(), "+79271234567", "x"); err == nil || !strings.Contains(err.Error(), "207") {
		t.Fatalf("want per-number error, got %v", err)
	}
	reply = `{"status":"ERROR","status_code":200,"status_text":"Неправильный api_id"}`
	if err := s.Send(context.Background(), "+79271234567", "x"); err == nil || !strings.Contains(err.Error(), "api_id") {
		t.Fatalf("want auth error, got %v", err)
	}
}
