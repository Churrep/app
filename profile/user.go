package profile

import "time"

const (
	MinAge   = 16
	AdultAge = 18
)

type Instrument struct {
	ID     string `json:"id"`
	IsMain bool   `json:"is_main"`
}

type User struct {
	ID               string
	Phone            string
	TelegramID       int64
	TelegramUsername string

	Name                 string
	BirthDate            time.Time // только дата, UTC
	District             string
	PhotoURL             string
	Instruments          []Instrument
	Level                int // 1–5 по основному инструменту
	Genres               []string
	Goals                []string
	LookingFor           string // band / musician / jam
	LookingForInstrument string // только для LookingFor == "musician"

	ShowAge      bool
	ShowDistrict bool
	Theme        string // dark / light

	ConsentAt *time.Time // согласие на обработку ПДн (152-ФЗ)
	CreatedAt time.Time
	UpdatedAt time.Time
	DeletedAt *time.Time
}

// Age возвращает полных лет на дату now.
func Age(birth, now time.Time) int {
	years := now.Year() - birth.Year()
	if now.Month() < birth.Month() || (now.Month() == birth.Month() && now.Day() < birth.Day()) {
		years--
	}
	return years
}

func (u User) Age(now time.Time) (int, bool) {
	if u.BirthDate.IsZero() {
		return 0, false
	}
	return Age(u.BirthDate, now), true
}

// IsMinor: 16–17 лет. Если дата рождения неизвестна — считаем несовершеннолетним (безопасный вариант).
func (u User) IsMinor(now time.Time) bool {
	age, ok := u.Age(now)
	return !ok || age < AdultAge
}

// Onboarding — какой обязательный шаг анкеты следующий.
// Репертуар, первое видео и установка на экран пропускаются, поэтому их тут нет.
type Onboarding struct {
	Complete bool   `json:"complete"`
	NextStep string `json:"next_step,omitempty"`
}

func (u User) Onboarding() Onboarding {
	step := ""
	switch {
	case u.BirthDate.IsZero() || u.ConsentAt == nil:
		step = "birth_date"
	case u.Name == "":
		step = "name"
	case len(u.Instruments) == 0:
		step = "instruments"
	case u.Level == 0:
		step = "level"
	case len(u.Genres) == 0:
		step = "genres"
	case u.LookingFor == "":
		step = "looking_for"
	}
	return Onboarding{Complete: step == "", NextStep: step}
}
