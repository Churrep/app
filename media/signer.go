package media

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/url"
	"strconv"
	"time"
)

// Signer выдаёт ссылки на приватные медиа, которые работают ограниченное время.
type Signer struct {
	Secret []byte
	Base   string // например /api/media
	TTL    time.Duration
	Now    func() time.Time
}

// URL округляет срок до 6 часов, чтобы ссылка на один файл не менялась
// при каждом запросе и браузер мог её кешировать.
func (s *Signer) URL(key string) string {
	if key == "" {
		return ""
	}
	const step = 6 * 3600
	exp := (s.Now().Add(s.TTL).Unix()/step + 1) * step
	q := url.Values{"exp": {strconv.FormatInt(exp, 10)}, "sig": {s.sign(key, exp)}}
	return s.Base + "/" + key + "?" + q.Encode()
}

func (s *Signer) Verify(key, exp, sig string) bool {
	e, err := strconv.ParseInt(exp, 10, 64)
	if err != nil || s.Now().Unix() > e {
		return false
	}
	return hmac.Equal([]byte(sig), []byte(s.sign(key, e)))
}

func (s *Signer) sign(key string, exp int64) string {
	m := hmac.New(sha256.New, s.Secret)
	m.Write([]byte(key + "|" + strconv.FormatInt(exp, 10)))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil)[:18])
}
