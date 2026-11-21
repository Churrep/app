package auth

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	ErrTelegramInvalid = errors.New("telegram: invalid auth data")
	ErrTelegramExpired = errors.New("telegram: auth data expired")
)

type TelegramUser struct {
	ID        int64
	FirstName string
	LastName  string
	Username  string
	PhotoURL  string
}

// VerifyTelegram проверяет данные виджета Telegram Login:
// https://core.telegram.org/widgets/login#checking-authorization
// body — JSON-объект, который виджет передаёт в onauth (id, first_name, …, auth_date, hash).
func VerifyTelegram(botToken string, body []byte, now time.Time) (TelegramUser, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		return TelegramUser{}, ErrTelegramInvalid
	}
	fields := make(map[string]string, len(raw))
	for k, v := range raw {
		switch v := v.(type) {
		case string:
			fields[k] = v
		case json.Number:
			fields[k] = v.String()
		default:
			return TelegramUser{}, ErrTelegramInvalid
		}
	}

	hash := strings.ToLower(fields["hash"])
	delete(fields, "hash")
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	lines := make([]string, len(keys))
	for i, k := range keys {
		lines[i] = k + "=" + fields[k]
	}

	secret := sha256.Sum256([]byte(botToken))
	mac := hmac.New(sha256.New, secret[:])
	mac.Write([]byte(strings.Join(lines, "\n")))
	if !hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(hash)) {
		return TelegramUser{}, ErrTelegramInvalid
	}

	authDate, err := strconv.ParseInt(fields["auth_date"], 10, 64)
	if err != nil {
		return TelegramUser{}, ErrTelegramInvalid
	}
	t := time.Unix(authDate, 0)
	if now.Sub(t) > 24*time.Hour || t.After(now.Add(5*time.Minute)) {
		return TelegramUser{}, ErrTelegramExpired
	}

	id, err := strconv.ParseInt(fields["id"], 10, 64)
	if err != nil || id <= 0 {
		return TelegramUser{}, ErrTelegramInvalid
	}
	return TelegramUser{
		ID:        id,
		FirstName: fields["first_name"],
		LastName:  fields["last_name"],
		Username:  fields["username"],
		PhotoURL:  fields["photo_url"],
	}, nil
}
