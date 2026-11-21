import { platform, useInstall } from '../install'
import { ShareIcon } from './Icons'

export function InstallGuide() {
  const { canPrompt, installed, prompt } = useInstall()
  const p = platform()

  if (installed) {
    return <p className="note">Приложение уже на экране «Домой». Открывай его оттуда.</p>
  }

  if (p === 'ios-safari') {
    return (
      <>
        <ol className="steps">
          <li>Нажми <ShareIcon width={18} height={18} className="inline-icon" /> «Поделиться» внизу Safari</li>
          <li>Выбери «На экран „Домой“»</li>
          <li>Нажми «Добавить»</li>
        </ol>
      </>
    )
  }

  if (p === 'ios-other') {
    return <p className="note">На iPhone поставить приложение можно только из Safari. Открой эту страницу в Safari.</p>
  }

  if (canPrompt) {
    return (
      <button className="btn btn-primary" onClick={prompt}>
        Установить
      </button>
    )
  }

  return <p className="note">Открой меню браузера и выбери «Установить приложение» или «Добавить на главный экран».</p>
}
