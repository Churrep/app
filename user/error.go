package user

import (
	"errors"
)

var (
	ErrEmptyLogin         = errors.New("логин не может быть пустым")
	ErrLoginLength        = errors.New("логин должен быть от 3 до 32 символов")
	ErrPasswordTooShort   = errors.New("пароль должен быть не короче 8 символов")
	ErrUserExists         = errors.New("пользователь с таким логином уже существует")
	ErrInvalidCredentials = errors.New("неверный логин или пароль")
)
