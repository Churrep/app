import { platform } from '../install'

// Экран «нет доступа к камере/микрофону» — инструкции отдельно для Safari и Chrome.
export function PermissionHelp({ what, onRetry }: { what: 'camera' | 'mic'; onRetry: () => void }) {
  const p = platform()
  const thing = what === 'camera' ? 'камере и микрофону' : 'микрофону'
  return (
    <div className="stack">
      <h2 className="title">Нет доступа к {thing}</h2>
      {p === 'ios-safari' || p === 'ios-other' ? (
        <ol className="steps">
          <li>Открой «Настройки» iPhone → «Safari»</li>
          <li>«Камера» и «Микрофон» → «Спрашивать» или «Разрешить»</li>
          <li>Вернись сюда и нажми «Попробовать ещё раз»</li>
        </ol>
      ) : (
        <ol className="steps">
          <li>Нажми на значок слева от адреса сайта (или ⋮ → «Настройки сайта»)</li>
          <li>Разреши {what === 'camera' ? '«Камера» и «Микрофон»' : '«Микрофон»'}</li>
          <li>Нажми «Попробовать ещё раз»</li>
        </ol>
      )}
      <button className="btn btn-primary" onClick={onRetry}>Попробовать ещё раз</button>
    </div>
  )
}

export function isPermissionError(e: unknown) {
  return e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
}

// Обработка звука браузера убивает музыку (шумодав режет инструменты), поэтому выключаем её.
export const musicAudio: MediaTrackConstraints = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

// Камера и микрофон работают только по защищённому адресу (https:// или localhost).
export const mediaAvailable = () => window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia)

export function InsecureHelp() {
  return (
    <div className="stack">
      <h2 className="title">Камера здесь не включится</h2>
      <p>Браузер разрешает камеру и микрофон только по защищённому адресу — он начинается с <b>https://</b>.</p>
      <ol className="steps">
        <li>Открой приложение по ссылке из <code>scripts/share.sh</code>, или</li>
        <li>на Mac запусти сайт командой <code>npm run dev:phone</code> и открой <b>https://</b>адрес из строки Network, приняв предупреждение о сертификате.</li>
      </ol>
    </div>
  )
}
