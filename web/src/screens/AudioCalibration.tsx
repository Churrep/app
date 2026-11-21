import { useEffect, useRef, useState } from 'react'
import { errorText } from '../api'
import { Header } from '../components/Header'
import { InsecureHelp, isPermissionError, mediaAvailable, PermissionHelp } from '../components/MediaHelp'
import {
  abortOnHide, declaredLatency, type Devices, Interrupted, keepAwake, levelMeter, listDevices, measureMarks, methodDefaults,
  openContext, openMic, type Outcome, precheck, routeLabels, sinkSupported, TapSession,
} from '../lib/calibration'
import {
  ALGO_VERSION, checkDevices, findResult, getPrefs, looksBluetooth, type Method, methodName, type Prefs, routeKey, saveResult, setPrefs, watchDevices,
} from '../lib/calibrationStore'

type Phase = 'setup' | 'precheck' | 'measuring' | 'tapping' | 'result' | 'denied'

const methodInfo: Record<Method, { title: string; text: string; scheme: string; hint: string }> = {
  A: {
    title: 'Кабель',
    text: 'Самый точный. Выход звуковой карты соединяешь кабелем со входом — меряется задержка самого устройства.',
    scheme: 'Выход (наушники / line out)  →  кабель  →  вход (line in)',
    hint: 'Нужна звуковая карта или переходник со входом. Начни с небольшой громкости.',
  },
  B: {
    title: 'Микрофон',
    text: 'Телефон играет метки из динамика и слушает их своим микрофоном. Нужна тишина.',
    scheme: 'Динамик или наушник  →  воздух, до 30 см  →  микрофон',
    hint: 'Держи телефон или наушник ближе 30 см к микрофону. Звук телефона — погромче.',
  },
  C: {
    title: 'Тап',
    text: 'Запасной вариант, например для Bluetooth-наушников. Звучат щелчки — нажимаешь в такт.',
    scheme: 'Слушаешь щелчки  →  нажимаешь на экран в такт',
    hint: 'Точность ниже: в результат входит твоя реакция. Это «эффективное смещение».',
  },
}

const statusText: Record<Outcome['status'], string> = { good: 'Хорошо', unreliable: 'Ненадёжно', error: 'Ошибка' }

const fmtMs = (v: number) => `${v.toFixed(1)} мс`

export function AudioCalibration() {
  const [prefs, setPrefsState] = useState<Prefs>(getPrefs)
  const [devices, setDevices] = useState<Devices | null>(null)
  const [phase, setPhase] = useState<Phase>('setup')
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [level, setLevel] = useState(-100)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [saved, setSaved] = useState(false)
  const [volume, setVolume] = useState(methodDefaults.B.volume)
  const [declared, setDeclared] = useState<ReturnType<typeof declaredLatency> | null>(null)
  const [stale, setStale] = useState(false)
  const [taps, setTaps] = useState(0)
  const [, rerender] = useState(0)

  const ctx = useRef<AudioContext | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const tap = useRef<TapSession | null>(null)
  const raf = useRef(0)

  const method = prefs.method

  function updatePrefs(p: Partial<Prefs>) {
    setPrefs(p)
    setPrefsState(getPrefs())
    setOutcome(null)
    setSaved(false)
    if (p.method && p.method !== 'C') setVolume(methodDefaults[p.method].volume)
  }

  useEffect(() => {
    if (navigator.mediaDevices) listDevices().then(setDevices).catch(() => {})
    checkDevices().then((changed) => changed && setStale(true))
    const unwatch = watchDevices(() => {
      setStale(true)
      listDevices().then(setDevices).catch(() => {})
    })
    return () => {
      unwatch()
      cancelAnimationFrame(raf.current)
      tap.current?.stop()
      stream.current?.getTracks().forEach((t) => t.stop())
      ctx.current?.close()
    }
  }, [])

  function releaseMic() {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }

  async function freshContext() {
    await ctx.current?.close()
    const { ctx: c, warnings: w } = await openContext(prefs.outputId)
    ctx.current = c
    setDeclared(declaredLatency(c))
    return { c, w }
  }

  async function start() {
    setError('')
    setOutcome(null)
    setSaved(false)
    setWarnings([])
    const release = await keepAwake()
    const hide = abortOnHide()
    let meter: ReturnType<typeof levelMeter> | null = null
    try {
      const { c, w } = await freshContext()
      const warn = [...w]
      if (method === 'C') {
        setWarnings(warn)
        await runTap(c, hide.signal)
        return
      }
      releaseMic()
      const mic = await openMic(prefs.inputId)
      stream.current = mic.stream
      warn.push(...mic.warnings)
      const d = await listDevices()
      setDevices(d)
      await checkDevices().then((changed) => changed && setStale(true))
      const labels = routeLabels(d, prefs.inputId, prefs.outputId)
      if (looksBluetooth(labels.input) || looksBluetooth(labels.output)) {
        warn.push('Похоже на беспроводные наушники: их задержка большая и меняется — калибруй заново при каждом подключении')
      }
      setWarnings(warn)

      meter = levelMeter(c, mic.stream)
      const m = meter
      const tick = () => {
        setLevel(m.db())
        raf.current = requestAnimationFrame(tick)
      }
      tick()

      setPhase('precheck')
      const pre = await precheck(c, mic.stream, method, volume, hide.signal)
      if (!pre.ok) {
        setError(`${pre.message}. Шум ${pre.noiseDb.toFixed(0)} дБ, метка ${pre.markDb.toFixed(0)} дБ`)
        setPhase('setup')
        return
      }
      setPhase('measuring')
      setProgress({ done: 0, total: methodDefaults[method].marks })
      const res = await measureMarks(c, mic.stream, method, {
        volume, signal: hide.signal, onProgress: (done, total) => setProgress({ done, total }),
      })
      setOutcome(res)
      setPhase('result')
    } catch (e) {
      if (isPermissionError(e)) setPhase('denied')
      else {
        setError(e instanceof Interrupted ? e.message : errorText(e))
        setPhase('setup')
      }
    } finally {
      cancelAnimationFrame(raf.current)
      meter?.dispose()
      releaseMic()
      hide.dispose()
      release()
    }
  }

  async function runTap(c: AudioContext, signal: AbortSignal) {
    const s = new TapSession(c)
    tap.current = s
    setTaps(0)
    setPhase('tapping')
    const { total, endsAt } = s.start()
    setProgress({ done: 0, total })
    await new Promise<void>((resolve, reject) => {
      const t = window.setInterval(() => {
        setProgress({ done: s.played(), total })
        if (c.currentTime >= endsAt) {
          clearInterval(t)
          resolve()
        }
      }, 100)
      signal.addEventListener('abort', () => {
        clearInterval(t)
        s.stop()
        reject(new Interrupted())
      }, { once: true })
    })
    setOutcome(s.result())
    tap.current = null
    setPhase('result')
  }

  function accept() {
    if (!outcome || !ctx.current || outcome.status === 'error') return
    saveResult(routeKey(prefs.inputId, prefs.outputId, ctx.current.sampleRate, method), {
      method, rtlMs: outcome.rtlMs, spreadMs: outcome.spreadMs, valid: outcome.valid, total: outcome.total,
      date: new Date().toISOString(), version: ALGO_VERSION, reliable: outcome.status === 'good',
    })
    setSaved(true)
    setStale(false)
    rerender((n) => n + 1)
  }

  if (!mediaAvailable()) {
    return <main className="screen"><Header title="Калибровка звука" back /><div className="screen-body"><InsecureHelp /></div></main>
  }
  if (phase === 'denied') {
    return <main className="screen"><Header title="Калибровка звука" back /><div className="screen-body"><PermissionHelp what="mic" onRetry={() => setPhase('setup')} /></div></main>
  }

  const busy = phase === 'precheck' || phase === 'measuring' || phase === 'tapping'
  const labels = routeLabels(devices, prefs.inputId, prefs.outputId)

  if (phase === 'tapping') {
    return (
      <main className="screen">
        <Header title="Тап в такт" />
        <div className="screen-body stack">
          <p className="note">Нажимай на большую кнопку точно на каждый щелчок. Первые 4 нажатия — разминка, они не считаются.</p>
          <div className="progress"><div style={{ width: `${(progress.done / (progress.total || 1)) * 100}%` }} /></div>
          <p className="small muted">Щелчок {progress.done} из {progress.total} · нажатий {taps}</p>
          <button className="tap-pad" onPointerDown={(e) => { e.preventDefault(); if (tap.current) setTaps(tap.current.tap(e.timeStamp)) }}>
            Тап
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="screen">
      <Header title="Калибровка звука" back={!busy} />
      <div className="screen-body stack-lg">
        <p className="muted">
          Меряем, на сколько твоя запись отстаёт от минуса: звук идёт в наушники, ты играешь, звук возвращается в микрофон.
          Эту задержку вычтем из каждой записи.
        </p>
        {stale && <p className="note warn-text">Устройства поменялись после прошлой калибровки — лучше откалибровать заново.</p>}

        <section className="field">
          <span className="label">Метод</span>
          <div className="options" role="radiogroup">
            {(['A', 'B', 'C'] as const).map((m) => {
              const info = methodInfo[m]
              const res = findResult(prefs.inputId, prefs.outputId, m)
              return (
                <button key={m} role="radio" aria-checked={method === m} className="option method-card" disabled={busy} onClick={() => updatePrefs({ method: m })}>
                  <span className="option-num">{m}</span>
                  <span className="stack-sm">
                    <strong>{info.title}</strong>
                    <span className="small">{info.text}</span>
                    {method === m && <span className="scheme small">{info.scheme}</span>}
                    {method === m && <span className="small muted">{info.hint}</span>}
                    {res && (
                      <span className={'small ' + (res.rec.stale ? 'warn-text' : 'ok-text')}>
                        Сохранено: {fmtMs(res.rec.rtlMs)} ±{res.rec.spreadMs.toFixed(1)} · {new Date(res.rec.date).toLocaleDateString('ru-RU')}
                        {res.rec.stale ? ' · устарела' : ''}{res.rec.reliable ? '' : ' · ненадёжно'}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <section className="card">
          <h3>Устройства</h3>
          {method !== 'C' && (
            <label className="field">
              <span className="label">Вход</span>
              <select className="input" value={prefs.inputId} disabled={busy} onChange={(e) => updatePrefs({ inputId: e.target.value })}>
                <option value="default">По умолчанию{devices?.defaultInput ? ` (${devices.defaultInput})` : ''}</option>
                {devices?.inputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </label>
          )}
          {sinkSupported() ? (
            <label className="field">
              <span className="label">Выход</span>
              <select className="input" value={prefs.outputId} disabled={busy} onChange={(e) => updatePrefs({ outputId: e.target.value })}>
                <option value="default">По умолчанию{devices?.defaultOutput ? ` (${devices.defaultOutput})` : ''}</option>
                {devices?.outputs.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </label>
          ) : (
            <p className="small muted">Выбрать выход этот браузер не даёт (умеют Chrome и Edge на компьютере) — звук идёт туда, куда настроено в системе.</p>
          )}
          {!devices?.inputs.length && method !== 'C' && <p className="small muted">Названия устройств появятся после разрешения на микрофон — нажми «Калибровать».</p>}
          {(looksBluetooth(labels.input) || looksBluetooth(labels.output)) && (
            <p className="small warn-text">Беспроводные наушники: задержка большая и нестабильная. Калибруй при каждом подключении или возьми проводные.</p>
          )}
        </section>

        {method !== 'C' && (
          <label className="field">
            <span className="label">Громкость метки: {Math.round(volume * 100)}%</span>
            <input type="range" min={0.05} max={1} step={0.05} value={volume} disabled={busy} onChange={(e) => setVolume(Number(e.target.value))} />
          </label>
        )}

        {busy && (
          <section className="card">
            <h3>{phase === 'precheck' ? 'Проверяем тишину и громкость…' : `Метка ${progress.done} из ${progress.total}`}</h3>
            {phase === 'precheck' && <p className="small">Пару секунд не шуми, потом прозвучит одна пробная метка.</p>}
            {phase === 'measuring' && <div className="progress"><div style={{ width: `${(progress.done / (progress.total || 1)) * 100}%` }} /></div>}
            <LevelBar db={level} />
            <p className="small muted">Не сворачивай приложение.</p>
          </section>
        )}

        {outcome && phase === 'result' && (
          <section className="card">
            <h3>Результат · {methodName[outcome.method]}</h3>
            <p className={'title ' + (outcome.status === 'good' ? 'ok-text' : outcome.status === 'unreliable' ? 'warn-text' : 'danger')}>
              {outcome.status === 'error' ? statusText.error : fmtMs(outcome.rtlMs)}
            </p>
            {outcome.status !== 'error' && (
              <p className="small">
                {outcome.method === 'C' ? 'Эффективное смещение' : 'Задержка'} · разброс ±{outcome.spreadMs.toFixed(1)} мс (MAD {outcome.madMs.toFixed(1)}) ·
                принято {outcome.valid} из {outcome.total} · {statusText[outcome.status]}
              </p>
            )}
            {outcome.reasons.map((r) => <p key={r} className="small warn-text">{r}</p>)}
            {outcome.warnings.map((w) => <p key={w} className="small muted">{w}</p>)}
            {saved ? <p className="ok-text">Сохранено. Будет учитываться при записи партии.</p> : (
              <div className="row">
                <button className="btn btn-secondary" onClick={start}>Повторить</button>
                <button className="btn btn-primary" disabled={outcome.status === 'error'} onClick={accept}>
                  {outcome.status === 'unreliable' ? 'Принять всё равно' : 'Принять'}
                </button>
              </div>
            )}
          </section>
        )}

        {warnings.map((w) => <p key={w} className="small warn-text">{w}</p>)}

        {declared && (
          <p className="small muted">
            Браузер заявляет: базовая {declared.baseMs.toFixed(1)} мс, выход {declared.outputMs ? `${declared.outputMs.toFixed(1)} мс` : 'неизвестно'},
            {' '}{declared.rate} Гц. Это только справка — в расчёт идёт замер.
          </p>
        )}
      </div>
      <div className="bottom-actions">
        {error && <p className="error-text" role="alert">{error}</p>}
        {phase !== 'result' && (
          <button className="btn btn-primary" disabled={busy} onClick={start}>{busy ? 'Слушаем…' : 'Калибровать'}</button>
        )}
      </div>
    </main>
  )
}

// LevelBar — уровень входа от −60 до 0 дБ.
function LevelBar({ db }: { db: number }) {
  const p = Math.max(0, Math.min(1, (db + 60) / 60))
  return (
    <div className="meter" aria-label={`Уровень входа ${db.toFixed(0)} дБ`}>
      <div style={{ width: `${p * 100}%` }} className={db > -3 ? 'clip' : ''} />
    </div>
  )
}
