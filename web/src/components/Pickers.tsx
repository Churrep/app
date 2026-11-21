import type { Catalog, Instrument, Item } from '../types'
import { nameOf } from '../types'

export function InstrumentPicker({ catalog, value, onChange }: { catalog: Catalog; value: Instrument[]; onChange: (v: Instrument[]) => void }) {
  const selected = new Set(value.map((i) => i.id))

  function toggle(id: string) {
    if (selected.has(id)) {
      const rest = value.filter((i) => i.id !== id)
      // Убрали основной — основным становится первый оставшийся.
      if (rest.length && !rest.some((i) => i.is_main)) rest[0] = { ...rest[0], is_main: true }
      onChange(rest)
    } else {
      onChange([...value, { id, is_main: value.length === 0 }])
    }
  }

  return (
    <>
      <div className="tiles">
        {catalog.instruments.map((it) => (
          <button key={it.id} type="button" className="tile" aria-pressed={selected.has(it.id)} onClick={() => toggle(it.id)}>
            {it.name}
            {value.find((i) => i.id === it.id)?.is_main && <span className="star" aria-label="основной">★</span>}
          </button>
        ))}
      </div>
      {value.length > 1 && (
        <div className="field">
          <span className="label">Основной инструмент</span>
          <div className="chips">
            {value.map((i) => (
              <button key={i.id} type="button" className="chip" aria-pressed={i.is_main}
                onClick={() => onChange(value.map((v) => ({ ...v, is_main: v.id === i.id })))}>
                {i.is_main ? '★ ' : ''}{nameOf(catalog.instruments, i.id)}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

export function ChipPicker({ items, value, onChange, max }: { items: Item[]; value: string[]; onChange: (v: string[]) => void; max?: number }) {
  const full = max !== undefined && value.length >= max
  return (
    <div className="chips">
      {items.map((it) => {
        const on = value.includes(it.id)
        return (
          <button key={it.id} type="button" className="chip" aria-pressed={on} disabled={!on && full}
            onClick={() => onChange(on ? value.filter((v) => v !== it.id) : [...value, it.id])}>
            {it.name}
          </button>
        )
      })}
    </div>
  )
}

export function LevelPicker({ catalog, value, onChange }: { catalog: Catalog; value?: number; onChange: (v: number) => void }) {
  return (
    <div className="options" role="radiogroup">
      {catalog.levels.map((l) => (
        <button key={l.value} type="button" role="radio" aria-checked={value === l.value} className="option" onClick={() => onChange(l.value)}>
          <span className="option-num">{l.value}</span>
          <span>{l.description}</span>
        </button>
      ))}
    </div>
  )
}

export function LookingForPicker({ catalog, value, instrument, onChange }: {
  catalog: Catalog
  value?: string
  instrument?: string
  onChange: (lookingFor: string, instrument: string) => void
}) {
  return (
    <>
      <div className="options" role="radiogroup">
        {catalog.looking_for.map((it) => (
          <button key={it.id} type="button" role="radio" aria-checked={value === it.id} className="option"
            onClick={() => onChange(it.id, it.id === 'musician' ? instrument ?? '' : '')}>
            {it.name}
          </button>
        ))}
      </div>
      {value === 'musician' && (
        <div className="field">
          <span className="label">Кто нужен?</span>
          <div className="chips">
            {catalog.instruments.map((it) => (
              <button key={it.id} type="button" className="chip" aria-pressed={instrument === it.id} onClick={() => onChange('musician', it.id)}>
                {it.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
