#set page(width: 310mm, height: auto, margin: 12mm, fill: rgb("#fafaf7"))
#set text(font: "Arial", size: 11pt, lang: "ru", fill: rgb("#182f39"))
#let ink = rgb("#18635f")
#let async-color = rgb("#61478b")
#let gray = rgb("#526575")
#let xs = (24mm, 80mm, 137mm, 196mm, 258mm)
#let at(x, y, body) = place(top + left, dx: x, dy: y, body)
#let msg(a, b, y, label, color: ink, reply: false) = {
  let x = xs.at(a)
  let dest = xs.at(b)
  let l = calc.min(x, dest)
  let span = calc.abs(dest - x)
  let dir = if dest > x { 1 } else { -1 }
  at(l, y, line(length: span, stroke: (paint: color, thickness: 0.9pt, dash: if reply { "dashed" } else { "solid" })))
  at(dest, y, line(end: (-dir * 2mm, -1.1mm), stroke: .9pt + color))
  at(dest, y, line(end: (-dir * 2mm, 1.1mm), stroke: .9pt + color))
  at(l, y - 5.7mm, block(width: span, align(center, box(fill: rgb("#fafaf7"), inset: (x: 2pt), text(size: 9.6pt, fill: color, label)))))
}
#text(size: 25pt, weight: "bold")[Как сервер принимает файл]
#h(1fr) #text(size: 10pt, fill: gray)[Джем · a742889]
#v(2pt)
Запись в ленту · время идёт сверху вниз. Обработчик HTTP и очередь работают в одном Go-сервере.
#v(8pt)
#block(width: 100%, height: 171mm)[
  #for (i, title) in ([Браузер / React], [Go / HTTP API], [PostgreSQL], [Очередь / FFmpeg], [Файлы / MEDIA_DIR]).enumerate() {
    let x = xs.at(i)
    at(x, 8mm, line(end: (0pt, 162mm), stroke: (paint: rgb("#acb9b6"), dash: "dotted", thickness: 0.8pt)))
    at(x - 23mm, 0pt, block(width: 46mm, inset: 5pt, radius: 3pt, fill: rgb("#203c46"), align(center, text(weight: "bold", fill: white, size: 10pt, title))))
  }
  #msg(0,1,19mm,[POST /api/videos])
  #msg(1,2,30mm,[Сессия и профиль])
  #msg(1,4,41mm,[Прочитать multipart и записать поток file под временным ключом raw])
  #msg(1,2,52mm,[INSERT · raw_key, processing])
  #msg(1,3,63mm,[Поставить ID записи в очередь])
  #msg(1,2,74mm,[Прочитать текущую запись])
  #msg(1,0,85mm,[201 Created · ID и статус], reply: true)
  #msg(3,2,99mm,[Получить raw_key по ID], color: async-color)
  #msg(3,4,110mm,[Исходник → MP4 или M4A], color: async-color)
  #msg(3,2,121mm,[Сохранить ключи и статус ready], color: async-color)
  #msg(3,4,132mm,[Удалить исходник после UPDATE], color: async-color)
  #msg(0,1,144mm,[GET /api/me/videos], color: gray)
  #msg(1,2,153mm,[Прочитать статусы и ключи], color: gray)
  #msg(1,0,164mm,[200 · записи и ссылки], color: gray, reply: true)
]
#text(weight: "bold", fill: ink)[Передача.] React отправляет поля формы и один файл через XMLHttpRequest с cookie и заголовком X-Upload: 1. Прокси снимает префикс /api. Go проверяет доступ, лимит загрузок и размер тела запроса.
#v(2pt)
#text(weight: "bold", fill: async-color)[Обработка.] После постановки в очередь HTTP-ответ и фоновая работа идут независимо. При ошибке перекодирования запись получает статус failed. Пока в профиле есть processing, клиент обновляет список каждые 4 секунды. В ответе API приходят статусы и подписанные ссылки для воспроизведения.
#v(7pt)
#table(columns: (1.4fr, .55fr, 2.35fr), inset: 5pt, stroke: none, fill: (x,y) => if y == 0 { rgb("#dee7e4") } else if calc.odd(y) { rgb("#f0f2ef") },
  [*Маршрут POST на Go-сервере*], [*Лимит тела*], [*Ответ и результат*],
  [`/videos`], [150 МиБ], [201 · видео или аудио для ленты → ready],
  [`/spots`], [50 МиБ], [201 · обработка минусовки → open],
  [`/spots/{id}/responses`], [60 МиБ], [201 · сведение партии с минусовкой → sent],
  [`/me/photo`], [15 МиБ], [Синхронно · FFmpeg создаёт JPEG, Go сохраняет ссылку в профиле → 200 с обновлённой анкетой],
)
