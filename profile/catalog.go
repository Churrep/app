package profile

// Справочники для онбординга и профиля. Фронтенд получает их через GET /catalog.

type Item struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Level struct {
	Value       int    `json:"value"`
	Description string `json:"description"`
}

// City — приложение работает только в Саратове.
const City = "Саратов"

const (
	MaxInstruments = 10
	MaxGenres      = 5
)

var Instruments = []Item{
	{"guitar", "Гитара"},
	{"bass", "Бас"},
	{"drums", "Барабаны"},
	{"keys", "Клавиши"},
	{"vocals", "Вокал"},
	{"violin", "Скрипка"},
	{"cello", "Виолончель"},
	{"sax", "Саксофон"},
	{"trumpet", "Труба"},
	{"flute", "Флейта"},
	{"percussion", "Перкуссия"},
	{"electronic", "Синтезаторы"},
	{"other", "Другое"},
}

var Genres = []Item{
	{"rock", "Рок"},
	{"indie", "Инди"},
	{"alternative", "Альтернатива"},
	{"punk", "Панк"},
	{"metal", "Метал"},
	{"pop", "Поп"},
	{"jazz", "Джаз"},
	{"blues", "Блюз"},
	{"funk", "Фанк"},
	{"soul", "Соул"},
	{"hiphop", "Хип-хоп"},
	{"electronic", "Электроника"},
	{"folk", "Фолк"},
	{"reggae", "Регги"},
	{"classical", "Классика"},
}

var Goals = []Item{
	{"hobby", "Хобби"},
	{"rehearsals", "Репетиции"},
	{"concerts", "Концерты"},
	{"recording", "Запись"},
	{"pro", "Профессиональный проект"},
}

var LookingFor = []Item{
	{"band", "Группу"},
	{"musician", "Музыканта"},
	{"jam", "Просто джем"},
}

var Levels = []Level{
	{1, "Учусь, играю отдельные аккорды или ритмы"},
	{2, "Играю несколько песен целиком, но с остановками"},
	{3, "Играю 10+ песен целиком под метроном без остановок"},
	{4, "Играл в группе, выступал, быстро снимаю партии"},
	{5, "Играю профессионально, могу сыграть почти что угодно"},
}

// Теги видео. Кавер — до 30 секунд.
var VideoTags = []Item{
	{"own", "Своё"},
	{"improv", "Импровизация"},
	{"exercise", "Упражнение"},
	{"cover", "Кавер"},
}

var VenueTypes = []Item{
	{"rehearsal", "Репбаза"},
	{"studio", "Студия записи"},
	{"school", "Музыкальная школа"},
	{"open_mic", "Бар с открытым микрофоном"},
	{"free", "Бесплатная площадка"},
}

var Equipment = []Item{
	{"drums", "Барабаны"},
	{"bass_amp", "Бас-комбик"},
	{"guitar_amp", "Гитарные комбики"},
	{"vocal_pa", "Вокальная линия"},
	{"keys", "Клавиши"},
}

func IsInstrument(id string) bool { return has(Instruments, id) }
func IsGenre(id string) bool      { return has(Genres, id) }
func IsVideoTag(id string) bool   { return has(VideoTags, id) }
func IsVenueType(id string) bool  { return has(VenueTypes, id) }

func LevelDescription(level int) string {
	for _, l := range Levels {
		if l.Value == level {
			return l.Description
		}
	}
	return ""
}

func has(items []Item, id string) bool {
	for _, it := range items {
		if it.ID == id {
			return true
		}
	}
	return false
}
