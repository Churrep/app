#set page(width: 280mm, height: auto, margin: 14mm, fill: rgb("#faf9f5"))
#set text(font: "Arial", size: 11pt, fill: rgb("#172b34"), lang: "ru")
#set par(leading: .6em)
#let teal = rgb("#006a66")
#let blue = rgb("#344f94")
#let muted = rgb("#53656c")
#let card(title, detail, color, bg) = block(width: 100%, inset: 10pt, fill: bg, stroke: (left: 2pt + color))[
  #text(weight: "bold", fill: color, size: 14pt, title)
  #v(2pt)
  #detail
]
#let pair(a,b) = grid(columns: (1fr, 1fr), gutter: 12pt, a, b)
#let arrow(label) = align(center)[#text(size: 12pt, fill: muted)[↓ #h(3pt) #label]]
#let left(title, detail) = card(title, detail, teal, rgb("#e4f2ee"))
#let right(title, detail) = card(title, detail, blue, rgb("#e9edf7"))
#let layer(title, path) = block(width: 100%, inset: (bottom: 4pt), stroke: (bottom: .65pt + rgb("#a2afaf")))[
  #text(weight: "bold", size: 13pt)[#title] #h(1fr) #text(size: 10pt, fill: muted)[#path]
]

#text(size: 28pt, weight: "bold")[Джем] #h(5pt) #text(size: 21pt)[Архитектура приложения]
#h(1fr) #text(size: 9pt, fill: muted)[Схема приложения]
#v(6pt)
#layer[Браузер · React PWA][web/src]
#pair(
  left[Найти напарника][Музыкант публикует запись, слушает ленту и лайкает записи. В профиле музыканта нажимает «Хочу поиграть»; два встречных предложения видны в разделе «Совпадения».],
  right[Попробоваться в группу][Группа публикует минусовку. Кандидат записывает партию в браузере и выбирает сдвиг и громкость перед отправкой.],
)
#arrow[HTTP · JSON и файлы · запросы к `/api/*` идут через прокси]
#layer[Go-сервер · один процесс приложения][main.go → server/]
#block(width: 100%, inset: 8pt, fill: rgb("#e8e9e4"))[
  *Общий вход* #h(4pt) `server` принимает HTTP-запросы. `auth` проверяет вход по СМС или Telegram и сессию по cookie. `profile` хранит анкету. Доступ к ленте и дорожкам открывается после заполнения профиля.
]
#pair(
  left[Лента и совпадения][`videos` принимает записи и формирует ленту. `likes` хранит лайки записей и предложения поиграть; совпадение — два встречных предложения.],
  right[Группы и отклики][`tracks` ведёт группы, свободные места и отклики. Группа слушает сведённую запись и сохраняет решение о приглашении.],
)
#arrow[Оба сценария передают записи в общий модуль media]
#block(width: 100%, inset: 10pt, fill: rgb("#193943"), text(fill: white)[
  *Обработка медиа* #h(8pt) `media.Queue` → два фоновых обработчика → FFmpeg. Перекодирование, превью и сведение партии с минусовкой. При запуске сервер возобновляет незавершённые задания по записям в базе.
])
#v(4pt)
#pair(arrow[Модули Go читают и обновляют строки], arrow[Модуль media пишет и отдаёт файлы])
#pair(
  card([PostgreSQL 17], [Профили и сессии, записи ленты, лайки записей и предложения поиграть, группы, места и отклики. Для медиа хранятся ключи файлов и статусы обработки.], muted, rgb("#e8e9e4")),
  card([Файловый том · MEDIA_DIR], [Аудио, видео, минусовки, сведённые отклики и изображения. Сервер выдаёт записи по подписанным ссылкам.], muted, rgb("#e8e9e4")),
)
