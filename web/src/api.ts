export class ApiError extends Error {
  status: number
  code: string
  field?: string

  constructor(status: number, code: string, message: string, field?: string) {
    super(message)
    this.status = status
    this.code = code
    this.field = field
  }

  get offline() {
    return this.code === 'offline'
  }
}

type Options = { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown }

// Сервер принимает изменяющие запросы только с Content-Type: application/json (защита от CSRF),
// поэтому POST без данных всё равно отправляет {}.
export async function api<T>(path: string, { method = 'GET', body }: Options = {}): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin' }
  if (method !== 'GET') {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body ?? {})
  }

  let res: Response
  try {
    res = await fetch('/api' + path, init)
  } catch {
    throw new ApiError(0, 'offline', 'Нет сети. Проверь интернет и попробуй ещё раз')
  }
  if (res.status === 204) return undefined as T

  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'unknown', data?.message ?? 'Что-то пошло не так. Попробуй ещё раз', data?.field)
  }
  return data as T
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Что-то пошло не так')

// Загрузка файла с прогрессом. Поля идут до файла: сервер читает поток по порядку.
export function upload<T>(path: string, fields: Record<string, string>, file: Blob, filename: string, onProgress?: (p: number) => void): Promise<T> {
  return uploadFiles(path, fields, [{ field: 'file', file, filename }], onProgress)
}

// uploadFiles — несколько файлов в одном запросе, каждый в своём поле формы.
export function uploadFiles<T>(path: string, fields: Record<string, string>, files: { field: string; file: Blob; filename: string }[], onProgress?: (p: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    for (const f of files) fd.append(f.field, f.file, f.filename)
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api' + path)
    xhr.withCredentials = true
    xhr.setRequestHeader('X-Upload', '1')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total)
    }
    xhr.onload = () => {
      let data: { error?: string; message?: string; field?: string } | null = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {
        // не JSON
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T)
      else reject(new ApiError(xhr.status, data?.error ?? 'unknown', data?.message ?? 'Не получилось загрузить. Попробуй ещё раз', data?.field))
    }
    xhr.onerror = () => reject(new ApiError(0, 'offline', 'Нет сети. Проверь интернет и попробуй ещё раз'))
    xhr.send(fd)
  })
}
