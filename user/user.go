package user

import (
	"strings"
	"sync"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

type User struct {
	Login    string
	Password string
}

var (
	mu    sync.RWMutex
	users = map[string]*User{}
)

func (u *User) Register(login string, password string) error {
	login = strings.TrimSpace(login)
	if login == "" {
		return ErrEmptyLogin
	}
	if n := utf8.RuneCountInString(login); n < 3 || n > 32 {
		return ErrLoginLength
	}
	if utf8.RuneCountInString(password) < 8 {
		return ErrPasswordTooShort
	}

	hash, err := hashPassword(password)
	if err != nil {
		return err
	}

	key := strings.ToLower(login)

	mu.Lock()
	defer mu.Unlock()
	if _, ok := users[key]; ok {
		return ErrUserExists
	}

	u.Login = login
	u.Password = hash
	users[key] = u
	return nil
}

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}
