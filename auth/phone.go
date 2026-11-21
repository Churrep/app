package auth

import (
	"errors"
	"strings"
)

var ErrBadPhone = errors.New("bad phone number")

// NormalizePhone приводит российский мобильный номер к виду +79XXXXXXXXX.
// Принимает «+7 (927) 123-45-67», «89271234567», «9271234567».
func NormalizePhone(s string) (string, error) {
	var b strings.Builder
	for i, r := range strings.TrimSpace(s) {
		switch {
		case r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '+' && i == 0, r == ' ', r == '-', r == '(', r == ')':
		default:
			return "", ErrBadPhone
		}
	}
	d := b.String()
	if len(d) == 11 && (d[0] == '7' || d[0] == '8') {
		d = d[1:]
	}
	if len(d) != 10 || d[0] != '9' {
		return "", ErrBadPhone
	}
	return "+7" + d, nil
}
