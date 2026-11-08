export interface SSEEvent {
  // Event type, top level on both majors: v1 `{ id, type, ... }`, v2 `{ id, type, data }`
  type?: string
  // v2 event body
  data?: {
    type?: string
  }
  // v1 event body, when the payload is nested
  payload?: {
    type?: string
  }
}

export type SSEEventHandler = (event: SSEEvent) => void

export async function processSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: SSEEventHandler,
) {
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data: ')) continue

      try {
        const event = JSON.parse(trimmed.slice(6)) as SSEEvent
        onEvent(event)
      } catch {
        // Skip on JSON parse failure
      }
    }
  }
}
