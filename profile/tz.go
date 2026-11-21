package profile

import (
	"time"
	_ "time/tzdata" // часовые пояса внутри бинарника: в минимальных контейнерах их нет
)

// Saratov — часовой пояс приложения (UTC+4): сроки, «открыто сейчас».
var Saratov = func() *time.Location {
	loc, err := time.LoadLocation("Europe/Saratov")
	if err != nil {
		return time.FixedZone("Europe/Saratov", 4*3600)
	}
	return loc
}()

// Today — сегодняшняя дата в Саратове (полночь UTC, как хранится date в базе).
func Today(now time.Time) time.Time {
	y, m, d := now.In(Saratov).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}
