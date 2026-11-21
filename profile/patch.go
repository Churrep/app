package profile

import (
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// Patch — тело PATCH /me. Меняются только переданные поля.
type Patch struct {
	Name                 *string       `json:"name"`
	BirthDate            *string       `json:"birth_date"` // ГГГГ-ММ-ДД
	Consent              *bool         `json:"consent"`
	District             *string       `json:"district"`
	PhotoURL             *string       `json:"photo_url"`
	Instruments          *[]Instrument `json:"instruments"`
	Level                *int          `json:"level"`
	Genres               *[]string     `json:"genres"`
	Goals                *[]string     `json:"goals"`
	LookingFor           *string       `json:"looking_for"`
	LookingForInstrument *string       `json:"looking_for_instrument"`
	ShowAge              *bool         `json:"show_age"`
	ShowDistrict         *bool         `json:"show_district"`
	Theme                *string       `json:"theme"`
}

type ValidationError struct {
	Field   string `json:"field"`
	Code    string `json:"error"`
	Message string `json:"message"`
}

func (e *ValidationError) Error() string { return e.Field + ": " + e.Message }

func invalid(field, code, msg string) error {
	return &ValidationError{Field: field, Code: code, Message: msg}
}

// Apply проверяет патч и применяет его к u. При ошибке u может быть изменён частично,
// поэтому вызывать на копии (так делает Store.Update).
func (p Patch) Apply(u *User, now time.Time) error {
	if p.Name != nil {
		name := strings.TrimSpace(*p.Name)
		if n := utf8.RuneCountInString(name); n == 0 || n > 40 {
			return invalid("name", "bad_name", "Имя — от 1 до 40 символов")
		}
		u.Name = name
	}

	if p.BirthDate != nil {
		d, err := time.Parse(time.DateOnly, *p.BirthDate)
		if err != nil {
			return invalid("birth_date", "bad_date", "Дата нужна в формате ГГГГ-ММ-ДД")
		}
		// Дату нельзя менять: иначе можно обойти ограничения для 16–17 лет.
		if !u.BirthDate.IsZero() && !u.BirthDate.Equal(d) {
			return invalid("birth_date", "birth_date_locked", "Дату рождения поменять нельзя. Напиши в поддержку")
		}
		age := Age(d, now)
		if d.After(now) || age > 100 {
			return invalid("birth_date", "bad_date", "Проверь дату рождения")
		}
		if age < MinAge {
			return invalid("birth_date", "too_young", "Приложение доступно с 16 лет")
		}
		u.BirthDate = d
	}

	if p.Consent != nil {
		switch {
		case *p.Consent && u.ConsentAt == nil:
			t := now
			u.ConsentAt = &t
		case !*p.Consent && u.ConsentAt != nil:
			return invalid("consent", "consent_locked", "Отозвать согласие можно, только удалив аккаунт")
		}
	}
	if !u.BirthDate.IsZero() && u.ConsentAt == nil {
		return invalid("consent", "consent_required", "Нужно согласие на обработку персональных данных")
	}

	if p.District != nil {
		district := strings.TrimSpace(*p.District)
		if utf8.RuneCountInString(district) > 50 {
			return invalid("district", "bad_district", "Район — до 50 символов")
		}
		u.District = district
	}

	if p.PhotoURL != nil {
		photo := strings.TrimSpace(*p.PhotoURL)
		if photo != "" && !isHTTPS(photo) {
			return invalid("photo_url", "bad_photo_url", "Ссылка на фото должна начинаться с https://")
		}
		u.PhotoURL = photo
	}

	if p.Instruments != nil {
		list := *p.Instruments
		if len(list) == 0 || len(list) > MaxInstruments {
			return invalid("instruments", "bad_instruments", "Выбери от 1 до 10 инструментов")
		}
		seen := map[string]bool{}
		mains := 0
		for _, in := range list {
			if !has(Instruments, in.ID) || seen[in.ID] {
				return invalid("instruments", "bad_instruments", "Проверь список инструментов")
			}
			seen[in.ID] = true
			if in.IsMain {
				mains++
			}
		}
		if mains != 1 {
			return invalid("instruments", "main_instrument_required", "Отметь звёздочкой один основной инструмент")
		}
		u.Instruments = append([]Instrument(nil), list...)
	}

	if p.Level != nil {
		if *p.Level < 1 || *p.Level > 5 {
			return invalid("level", "bad_level", "Уровень — от 1 до 5")
		}
		u.Level = *p.Level
	}

	if p.Genres != nil {
		if !validSet(*p.Genres, Genres, MaxGenres) {
			return invalid("genres", "bad_genres", "Выбери до 5 жанров из списка")
		}
		u.Genres = append([]string(nil), *p.Genres...)
	}

	if p.Goals != nil {
		if !validSet(*p.Goals, Goals, len(Goals)) {
			return invalid("goals", "bad_goals", "Проверь список целей")
		}
		u.Goals = append([]string(nil), *p.Goals...)
	}

	if p.LookingFor != nil || p.LookingForInstrument != nil {
		if p.LookingFor != nil {
			if !has(LookingFor, *p.LookingFor) {
				return invalid("looking_for", "bad_looking_for", "Выбери: группу, музыканта или джем")
			}
			u.LookingFor = *p.LookingFor
		}
		if p.LookingForInstrument != nil {
			if *p.LookingForInstrument != "" && !has(Instruments, *p.LookingForInstrument) {
				return invalid("looking_for_instrument", "bad_instruments", "Такого инструмента нет в списке")
			}
			u.LookingForInstrument = *p.LookingForInstrument
		}
		if u.LookingFor != "musician" {
			u.LookingForInstrument = ""
		} else if u.LookingForInstrument == "" {
			return invalid("looking_for_instrument", "looking_for_instrument_required", "Выбери, какой музыкант нужен")
		}
	}

	if p.ShowAge != nil {
		u.ShowAge = *p.ShowAge
	}
	if p.ShowDistrict != nil {
		u.ShowDistrict = *p.ShowDistrict
	}

	if p.Theme != nil {
		if *p.Theme != "dark" && *p.Theme != "light" {
			return invalid("theme", "bad_theme", "Тема: dark или light")
		}
		u.Theme = *p.Theme
	}
	return nil
}

func validSet(values []string, allowed []Item, max int) bool {
	if len(values) > max {
		return false
	}
	seen := map[string]bool{}
	for _, v := range values {
		if !has(allowed, v) || seen[v] {
			return false
		}
		seen[v] = true
	}
	return true
}

func isHTTPS(s string) bool {
	u, err := url.Parse(s)
	return err == nil && u.Scheme == "https" && u.Host != "" && len(s) <= 500
}
