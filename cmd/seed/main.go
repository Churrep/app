// Команда seed добавляет тестовые данные: 15 репетиционных точек в разных районах Саратова.
// Названия, адреса и телефоны вымышленные и помечены «[Тест]», verified_at пустой — в приложении «Не проверено».
// Повторный запуск ничего не дублирует.
//
//	DATABASE_URL=... go run ./cmd/seed
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"music/db"
)

type venue struct {
	name, typ, address, district string
	lat, lon                     float64
	priceMin, priceMax           int
	rooms                        int
	equipment                    []string
	hours                        string
}

const (
	daily     = `{"mon":["10:00-23:00"],"tue":["10:00-23:00"],"wed":["10:00-23:00"],"thu":["10:00-23:00"],"fri":["10:00-23:00"],"sat":["12:00-23:00"],"sun":["12:00-22:00"]}`
	late      = `{"mon":["14:00-02:00"],"tue":["14:00-02:00"],"wed":["14:00-02:00"],"thu":["14:00-02:00"],"fri":["14:00-04:00"],"sat":["12:00-04:00"],"sun":["12:00-00:00"]}`
	allDay    = `{"mon":["00:00-24:00"],"tue":["00:00-24:00"],"wed":["00:00-24:00"],"thu":["00:00-24:00"],"fri":["00:00-24:00"],"sat":["00:00-24:00"],"sun":["00:00-24:00"]}`
	weekdays  = `{"mon":["09:00-21:00"],"tue":["09:00-21:00"],"wed":["09:00-21:00"],"thu":["09:00-21:00"],"fri":["09:00-21:00"]}`
	barNights = `{"thu":["19:00-02:00"],"fri":["19:00-03:00"],"sat":["19:00-03:00"]}`
)

var full = []string{"drums", "bass_amp", "guitar_amp", "vocal_pa", "keys"}

var venues = []venue{
	{"[Тест] Репбаза «Подвал»", "rehearsal", "ул. Московская, 1 (тест)", "Волжский", 51.5332, 46.0420, 500, 700, 3, full, late},
	{"[Тест] Репбаза «Гараж 64»", "rehearsal", "ул. Чапаева, 2 (тест)", "Фрунзенский", 51.5298, 46.0335, 400, 600, 2, []string{"drums", "bass_amp", "guitar_amp", "vocal_pa"}, daily},
	{"[Тест] Репточка на Рахова", "rehearsal", "ул. Рахова, 3 (тест)", "Октябрьский", 51.5431, 46.0225, 350, 450, 1, []string{"drums", "guitar_amp", "vocal_pa"}, late},
	{"[Тест] Репбаза «Шум»", "rehearsal", "пр. Кирова, 4 (тест)", "Кировский", 51.5398, 46.0101, 600, 900, 4, full, allDay},
	{"[Тест] Репбаза «Сосновка»", "rehearsal", "ул. Тархова, 5 (тест)", "Ленинский", 51.5868, 45.9662, 300, 400, 2, []string{"drums", "bass_amp", "guitar_amp"}, daily},
	{"[Тест] Репбаза «Завод»", "rehearsal", "ул. Огородная, 6 (тест)", "Заводской", 51.4952, 46.0981, 300, 500, 2, []string{"drums", "guitar_amp", "vocal_pa"}, late},
	{"[Тест] Репбаза «Солнечный»", "rehearsal", "ул. Международная, 7 (тест)", "Ленинский", 51.5951, 45.9811, 350, 500, 1, []string{"drums", "vocal_pa"}, daily},
	{"[Тест] Студия «Плёнка»", "studio", "ул. Большая Казачья, 8 (тест)", "Кировский", 51.5475, 46.0152, 1200, 2500, 2, []string{"drums", "keys", "vocal_pa"}, weekdays},
	{"[Тест] Студия звукозаписи «Волна»", "studio", "ул. Астраханская, 9 (тест)", "Октябрьский", 51.5389, 46.0201, 1500, 3000, 1, []string{"keys", "vocal_pa"}, daily},
	{"[Тест] Студия «Набережная»", "studio", "ул. Шелковичная, 10 (тест)", "Волжский", 51.5268, 46.0598, 1000, 2000, 1, []string{"drums", "bass_amp", "guitar_amp", "keys"}, daily},
	{"[Тест] Музыкальная школа №0", "school", "ул. Вольская, 11 (тест)", "Фрунзенский", 51.5312, 46.0281, 0, 300, 6, []string{"keys", "drums"}, weekdays},
	{"[Тест] Школа рока «Аккорд»", "school", "ул. Соколовая, 12 (тест)", "Октябрьский", 51.5561, 46.0302, 400, 800, 3, full, weekdays},
	{"[Тест] Бар «Открытый микрофон»", "open_mic", "ул. Чернышевского, 13 (тест)", "Волжский", 51.5402, 46.0612, 0, 0, 1, []string{"vocal_pa", "guitar_amp"}, barNights},
	{"[Тест] Паб «Джем по четвергам»", "open_mic", "пр. Энтузиастов, 14 (тест)", "Заводской", 51.5103, 46.0752, 0, 0, 1, []string{"drums", "bass_amp", "guitar_amp", "vocal_pa"}, barNights},
	{"[Тест] Свободная сцена в парке", "free", "Городской парк, 15 (тест)", "Октябрьский", 51.5502, 45.9952, 0, 0, 1, []string{}, `{"sat":["12:00-20:00"],"sun":["12:00-20:00"]}`},
}

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		log.Fatal("нужен DATABASE_URL")
	}
	ctx := context.Background()
	pool, err := db.Open(ctx, url)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool); err != nil {
		log.Fatal(err)
	}

	added := 0
	for i, v := range venues {
		id := fmt.Sprintf("00000000-0000-4000-a000-%012d", i+1)
		var priceMin, priceMax *int
		if v.priceMax > 0 {
			priceMin, priceMax = &v.priceMin, &v.priceMax
		}
		phone := fmt.Sprintf("+7 (900) 000-00-%02d", i+1)
		tag, err := pool.Exec(ctx, `INSERT INTO venues (id, name, type, address, location, district, price_per_hour_min, price_per_hour_max,
			opening_hours, rooms_count, equipment, phones, status)
			VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8, $9, $10, $11, $12, $13, 'published')
			ON CONFLICT (id) DO NOTHING`,
			id, v.name, v.typ, v.address, v.lon, v.lat, v.district, priceMin, priceMax, v.hours, v.rooms, v.equipment, []string{phone})
		if err != nil {
			log.Fatalf("%s: %v", v.name, err)
		}
		added += int(tag.RowsAffected())
	}
	fmt.Printf("Точек добавлено: %d (всего в сиде %d)\n", added, len(venues))
}
