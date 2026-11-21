package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SMSRu отправляет СМС через sms.ru (https://sms.ru/api/send).
// Нужен api_id из личного кабинета sms.ru; каждое сообщение платное.
type SMSRu struct {
	APIID  string
	Test   bool   // test=1: sms.ru проверяет запрос, но не отправляет и не списывает деньги
	From   string // имя отправителя, если согласовано в sms.ru; пусто — отправитель по умолчанию
	URL    string // для тестов; пусто — https://sms.ru/sms/send
	Client *http.Client
}

func (s SMSRu) Send(ctx context.Context, phone, text string) error {
	endpoint := s.URL
	if endpoint == "" {
		endpoint = "https://sms.ru/sms/send"
	}
	to := strings.TrimPrefix(phone, "+")
	form := url.Values{"api_id": {s.APIID}, "to": {to}, "msg": {text}, "json": {"1"}}
	if s.Test {
		form.Set("test", "1")
	}
	if s.From != "" {
		form.Set("from", s.From)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	client := s.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("sms.ru: %w", err)
	}
	defer resp.Body.Close()

	var data struct {
		Status     string `json:"status"`
		StatusCode int    `json:"status_code"`
		StatusText string `json:"status_text"`
		SMS        map[string]struct {
			Status     string `json:"status"`
			StatusCode int    `json:"status_code"`
			StatusText string `json:"status_text"`
		} `json:"sms"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return fmt.Errorf("sms.ru: ответ %d не JSON: %w", resp.StatusCode, err)
	}
	if data.Status != "OK" {
		return fmt.Errorf("sms.ru: %d %s", data.StatusCode, data.StatusText)
	}
	if r, ok := data.SMS[to]; !ok || r.Status != "OK" {
		return fmt.Errorf("sms.ru: номер не принят: %d %s", r.StatusCode, r.StatusText)
	}
	return nil
}
