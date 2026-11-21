// Package media хранит файлы, обрабатывает их через FFmpeg и выдаёт подписанные ссылки.
package media

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Storage — файлы на локальном диске. Для прода её заменит S3-совместимое хранилище в РФ
// с тем же набором операций.
type Storage struct {
	Dir string
}

func NewStorage(dir string) (*Storage, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	return &Storage{Dir: abs}, nil
}

var ErrBadKey = errors.New("media: bad key")

func validKey(key string) bool {
	return key != "" && !strings.Contains(key, "..") && !strings.HasPrefix(key, "/") && !strings.Contains(key, "\\")
}

// Path — путь к файлу на диске (FFmpeg работает с файлами).
func (s *Storage) Path(key string) (string, error) {
	if !validKey(key) {
		return "", ErrBadKey
	}
	return filepath.Join(s.Dir, filepath.FromSlash(key)), nil
}

// Prepare создаёт папку для ключа и возвращает путь — для файлов, которые пишет FFmpeg.
func (s *Storage) Prepare(key string) (string, error) {
	path, err := s.Path(key)
	if err != nil {
		return "", err
	}
	return path, os.MkdirAll(filepath.Dir(path), 0o755)
}

// Save записывает поток в файл атомарно: сначала во временный, потом переименование.
func (s *Storage) Save(key string, r io.Reader) (int64, error) {
	path, err := s.Path(key)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return 0, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".upload-*")
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(tmp, r)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp.Name())
		return n, err
	}
	return n, os.Rename(tmp.Name(), path)
}

// Remove удаляет файлы; пустые ключи и отсутствующие файлы пропускает.
func (s *Storage) Remove(keys ...string) {
	for _, k := range keys {
		if p, err := s.Path(k); err == nil {
			os.Remove(p)
		}
	}
}

// NewKey — случайный ключ вида prefix/xxxxxxxx.ext.
func NewKey(prefix, ext string) string {
	b := make([]byte, 16)
	rand.Read(b)
	return prefix + "/" + hex.EncodeToString(b) + ext
}
