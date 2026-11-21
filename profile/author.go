package profile

import (
	"fmt"
	"time"
)

// Author — короткая карточка музыканта для ленты, откликов и списков.
// Правила приватности те же, что у PublicView: район 16–17-летних скрыт всегда.
type Author struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	PhotoURL       string   `json:"photo_url"`
	MainInstrument string   `json:"main_instrument"`
	Level          int      `json:"level"`
	Genres         []string `json:"genres"`
	District       string   `json:"district,omitempty"`
	LookingFor     string   `json:"looking_for"`
}

// AuthorSQL — колонки для SELECT по таблице users с алиасом a. Сканировать через AuthorScan.
func AuthorSQL(a string) string {
	return fmt.Sprintf(`%[1]s.id::text, %[1]s.name, %[1]s.photo_url,
		coalesce((SELECT instrument_id FROM user_instruments ui WHERE ui.user_id = %[1]s.id AND ui.is_main), ''),
		%[1]s.level,
		coalesce((SELECT array_agg(genre_id ORDER BY position) FROM user_genres ug WHERE ug.user_id = %[1]s.id), '{}'),
		%[1]s.district, %[1]s.show_district, %[1]s.birth_date, %[1]s.looking_for`, a)
}

type AuthorScan struct {
	a            Author
	showDistrict bool
	birth        *time.Time
}

func (s *AuthorScan) Dest() []any {
	return []any{&s.a.ID, &s.a.Name, &s.a.PhotoURL, &s.a.MainInstrument, &s.a.Level, &s.a.Genres,
		&s.a.District, &s.showDistrict, &s.birth, &s.a.LookingFor}
}

// Minor — автору 16–17 лет (или дата неизвестна).
func (s *AuthorScan) Minor(now time.Time) bool {
	u := User{}
	if s.birth != nil {
		u.BirthDate = *s.birth
	}
	return u.IsMinor(now)
}

func (s *AuthorScan) Author(now time.Time) Author {
	a := s.a
	if a.Genres == nil {
		a.Genres = []string{}
	}
	u := User{}
	if s.birth != nil {
		u.BirthDate = *s.birth
	}
	if !s.showDistrict || u.IsMinor(now) {
		a.District = ""
	}
	return a
}
