package media

import (
	"encoding/json"
	"strings"
)

// Media — всё для работы с файлами в одном месте.
type Media struct {
	Storage *Storage
	Signer  *Signer
	FF      FFmpeg
	Queue   *Queue
	// FFErr — почему FFmpeg недоступен (nil — всё в порядке). Без FFmpeg загрузки отклоняются.
	FFErr error
}

// PeaksJSON/ParsePeaks — волна хранится в jsonb.
func PeaksJSON(p []float64) []byte {
	if p == nil {
		p = []float64{}
	}
	b, _ := json.Marshal(p)
	return b
}

func ParsePeaks(b []byte) []float64 {
	var p []float64
	if json.Unmarshal(b, &p) != nil || p == nil {
		return []float64{}
	}
	return p
}

// UserError — ошибка обработки, которую можно показать пользователю.
type UserError struct{ Message string }

func (e *UserError) Error() string { return e.Message }

// ErrorText — текст для поля error в базе: пользовательские ошибки как есть, остальное — общая фраза.
func ErrorText(err error) string {
	if ue, ok := err.(*UserError); ok {
		return ue.Message
	}
	if strings.Contains(err.Error(), "Invalid data") || strings.Contains(err.Error(), "в файле нет звука") {
		return "Не получилось прочитать файл. Попробуй записать ещё раз"
	}
	return "Не получилось обработать файл. Попробуй ещё раз"
}
