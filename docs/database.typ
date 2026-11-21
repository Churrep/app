#set page(width: 298mm, height: auto, margin: 10mm, fill: rgb("#fafaf7"))
#set text(font: "Arial", size: 10pt, fill: rgb("#233c48"), lang: "ru")
#let teal = rgb("#136e6c")
#let blue = rgb("#405c9b")
#let purple = rgb("#784985")
#let at(x,y,b) = place(top+left, dx:x*1mm, dy:y*1mm, b)
#let table-width = 65
#let card(x,y,name,rows) = {
  at(x,y,block(width:table-width*1mm, stroke:.5pt+rgb("#b4c3c7"), fill:white, radius:2pt, clip:true)[
    #set block(spacing: 0pt)
    #block(width:100%, height:7mm, inset:(x:3mm), fill:rgb("#243f4c"), align(horizon, text(fill:white, weight:"bold",name)))
    #for (key,col,typ) in rows {
      block(width:100%, height:5mm, inset:(x:2mm), align(horizon, grid(columns:(12mm,1fr,auto),
        text(size:8pt,fill:teal,weight:"bold",key), text(font:"Menlo",size:8pt,col), text(size:8pt,fill:gray,typ))))
    }
  ])
}
#let link(points, color, optional:false) = {
  for (a,b) in points.zip(points.slice(1)) {
    at(a.at(0),a.at(1),line(end:((b.at(0)-a.at(0))*1mm,(b.at(1)-a.at(1))*1mm),stroke:(paint:color,thickness:.85pt,dash:if optional {"dashed"} else {"solid"})))
  }
  let (x,y) = points.last()
  let (px,py) = points.at(-2)
  let d = if x>px {1} else {-1}
  at(x,y,line(end:(-d*2mm,-1.1mm),stroke:.95pt+color))
  at(x,y,line(end:(-d*2mm,1.1mm),stroke:.95pt+color))
}
#let pk = ("PK","id","uuid")
#let user(y) = card(0,y,"users",(pk,))
#let row(y) = y+9.5
#let group(t) = block(width:100%, inset:(bottom:2pt),stroke:(bottom:.6pt+rgb("#aebcbd")),text(size:13pt,weight:"bold",t))

#text(size:23pt,weight:"bold")[Джем · связи таблиц PostgreSQL]
#h(1fr) #text(fill:gray)[Схема приложения]
#v(3pt)
Стрелка идёт от внешнего ключа (FK) к первичному (PK). Каждая дочерняя строка ссылается на одну родительскую; у родителя может быть любое число дочерних строк. Пунктир допускает NULL. Несколько отметок PK образуют составной ключ.
#v(5pt)
#group[Профиль и доступ]
#v(5mm)
#block(width:100%,height:55mm)[
  #let u = row(15)
  #for (y,src,bus) in ((0,107,82),(28,107,87),(0,208,190)) {
    let target-y = row(y) + if src == 208 {5} else {0}
    if src == 107 {
      link(((src,target-y),(bus,target-y),(bus,u),(65,u)),teal)
    } else {
      let lane = -2
      link(((src,target-y),(bus,target-y),(bus,lane),(73,lane),(73,u),(65,u)),teal)
    }
  }
  #user(15)
  #card(107,0,"user_instruments",(("PK FK","user_id","uuid"),("PK","instrument_id","text")))
  #card(107,28,"user_genres",(("PK FK","user_id","uuid"),("PK","genre_id","text")))
  #card(208,0,"sessions",(("PK","token_hash","bytea"),("FK","user_id","uuid")))
]
#group[Лента и знакомства]
#v(5mm)
#block(width:100%,height:53mm)[
  #let u = row(20)
  #link(((107,row(0)+5),(86,row(0)+5),(86,u),(65,u)),teal)
  #for (y,bus,lane) in ((9.5,181,-2),(39.5,184,49),(44.5,191,52)) {
    link(((208,y),(bus,y),(bus,lane),(75,lane),(75,u),(65,u)),teal)
  }
  #link(((208,14.5),(177,14.5),(177,9.5),(172,9.5)),blue)
  #user(20)
  #card(107,0,"videos",(pk,("FK","user_id","uuid")))
  // likes — лайк записи; play_invites — «Хочу поиграть». Совпадение = два встречных предложения, отдельно не хранится.
  #card(208,0,"likes",(("PK FK","user_id","uuid"),("PK FK","video_id","uuid")))
  #card(208,25,"play_invites",(("PK FK","from_user_id","uuid"),("PK FK","to_user_id","uuid")))
]
#group[Группы и прослушивания]
#v(5mm)
#block(width:100%,height:84mm)[
  #let u = row(28)
  #link(((104,18.5),(83,18.5),(83,u),(65,u)),teal)
  #link(((208,9.5),(186,9.5),(186,13.5),(169,13.5)),blue)
  #link(((208,14.5),(196,14.5),(196,-2),(73,-2),(73,u),(65,u)),teal)
  #link(((208,38.5),(180,38.5),(180,13.5),(169,13.5)),blue)
  #link(((208,43.5),(88,43.5),(88,u),(65,u)),teal,optional:true)
  #link(((208,67.5),(185,67.5),(185,33.5),(208,33.5)),purple)
  #link(((208,72.5),(78,72.5),(78,u),(65,u)),teal)
  #user(28)
  #card(104,4,"bands",(pk,("FK","created_by","uuid")))
  #card(208,0,"band_members",(("PK FK","band_id","uuid"),("PK FK","user_id","uuid")))
  #card(208,24,"open_spots",(pk,("FK","band_id","uuid"),("FK","created_by","uuid?")))
  #card(208,53,"spot_responses",(pk,("FK","spot_id","uuid"),("FK","user_id","uuid")))
]
#text(size:9pt)[Показаны ключевые колонки. Карточка users повторена в трёх разделах. Отдельная служебная таблица schema_migrations имеет PK version и хранит историю миграций.]
