// Package apperr — ошибки с HTTP-статусом и текстом для пользователя.
package apperr

import "net/http"

type Error struct {
	Status  int
	Code    string
	Message string
	Field   string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func Invalid(field, msg string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "invalid", Message: msg, Field: field}
}

func NotFound(msg string) *Error {
	return &Error{Status: http.StatusNotFound, Code: "not_found", Message: msg}
}

func Forbidden(msg string) *Error {
	return &Error{Status: http.StatusForbidden, Code: "forbidden", Message: msg}
}

func Conflict(code, msg string) *Error {
	return &Error{Status: http.StatusConflict, Code: code, Message: msg}
}
