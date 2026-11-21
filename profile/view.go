package profile

import "time"

// MeView — свой профиль со всеми полями и настройками.
type MeView struct {
	ID                   string       `json:"id"`
	Phone                string       `json:"phone,omitempty"`
	TelegramUsername     string       `json:"telegram_username,omitempty"`
	Name                 string       `json:"name"`
	BirthDate            string       `json:"birth_date,omitempty"`
	Age                  *int         `json:"age,omitempty"`
	District             string       `json:"district"`
	PhotoURL             string       `json:"photo_url"`
	Instruments          []Instrument `json:"instruments"`
	Level                int          `json:"level,omitempty"`
	LevelDescription     string       `json:"level_description,omitempty"`
	Genres               []string     `json:"genres"`
	Goals                []string     `json:"goals"`
	LookingFor           string       `json:"looking_for,omitempty"`
	LookingForInstrument string       `json:"looking_for_instrument,omitempty"`
	ShowAge              bool         `json:"show_age"`
	ShowDistrict         bool         `json:"show_district"`
	Theme                string       `json:"theme"`
	ConsentAt            *time.Time   `json:"consent_at,omitempty"`
	Onboarding           Onboarding   `json:"onboarding"`
	CreatedAt            time.Time    `json:"created_at"`
}

// PublicView — чужой профиль с учётом приватности и правил для 16–17 лет.
type PublicView struct {
	ID                   string       `json:"id"`
	Name                 string       `json:"name"`
	Age                  *int         `json:"age,omitempty"`
	District             string       `json:"district,omitempty"`
	PhotoURL             string       `json:"photo_url"`
	Instruments          []Instrument `json:"instruments"`
	Level                int          `json:"level"`
	LevelDescription     string       `json:"level_description"`
	Genres               []string     `json:"genres"`
	Goals                []string     `json:"goals"`
	LookingFor           string       `json:"looking_for"`
	LookingForInstrument string       `json:"looking_for_instrument,omitempty"`
}

func (u User) Me(now time.Time) MeView {
	v := MeView{
		ID:                   u.ID,
		Phone:                u.Phone,
		TelegramUsername:     u.TelegramUsername,
		Name:                 u.Name,
		District:             u.District,
		PhotoURL:             u.PhotoURL,
		Instruments:          orEmpty(u.Instruments),
		Level:                u.Level,
		LevelDescription:     LevelDescription(u.Level),
		Genres:               orEmpty(u.Genres),
		Goals:                orEmpty(u.Goals),
		LookingFor:           u.LookingFor,
		LookingForInstrument: u.LookingForInstrument,
		ShowAge:              u.ShowAge,
		ShowDistrict:         u.ShowDistrict,
		Theme:                u.Theme,
		ConsentAt:            u.ConsentAt,
		Onboarding:           u.Onboarding(),
		CreatedAt:            u.CreatedAt,
	}
	if age, ok := u.Age(now); ok {
		v.BirthDate = u.BirthDate.Format(time.DateOnly)
		v.Age = &age
	}
	return v
}

func (u User) Public(now time.Time) PublicView {
	v := PublicView{
		ID:                   u.ID,
		Name:                 u.Name,
		PhotoURL:             u.PhotoURL,
		Instruments:          orEmpty(u.Instruments),
		Level:                u.Level,
		LevelDescription:     LevelDescription(u.Level),
		Genres:               orEmpty(u.Genres),
		Goals:                orEmpty(u.Goals),
		LookingFor:           u.LookingFor,
		LookingForInstrument: u.LookingForInstrument,
	}
	if age, ok := u.Age(now); ok && u.ShowAge {
		v.Age = &age
	}
	// Район 16–17-летних скрыт всегда.
	if u.ShowDistrict && !u.IsMinor(now) {
		v.District = u.District
	}
	return v
}

func orEmpty[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}
