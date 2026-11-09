import { Container } from '@cloudflare/containers'
import { env } from 'cloudflare:workers'
import { processSSEStream } from './sse'

const PORT = 2633

// Events that prove a session is alive and must keep the container awake.
// `session.updated` is v1-only; v2 emits `session.created` / `session.renamed`.
const ACTIVITY_EVENTS = new Set([
  'session.updated',
  'session.created',
  'session.execution.started',
  'session.renamed',
])

// High-frequency streaming events renew activity on a throttled interval so
// single turns running longer than `sleepAfter` do not let the container sleep.
const STREAMING_ACTIVITY_EVENTS = new Set(['message.updated', 'message.part.updated'])
const ACTIVITY_RENEW_INTERVAL_MS = 60_000

const containerEnv = Object.fromEntries(
  Object.entries(env).filter(([, value]) => typeof value === 'string'),
) as Record<string, string>

// OpenCode v2 guards `/api/*` with Basic auth (`opencode:<password>`). Reuse the
// Worker gate password unless a dedicated container password is provided so a v2
// image works without extra configuration. v1 ignores the header.
const opencodePassword = containerEnv.OPENCODE_PASSWORD || containerEnv.SERVER_PASSWORD

function containerAuthorization(): string | null {
  return opencodePassword ? `Basic ${btoa(`opencode:${opencodePassword}`)}` : null
}

export class AgentContainer extends Container {
  sleepAfter = '10m'
  defaultPort = PORT

  private _watchPromise?: Promise<void>
  private _lastRenewedAt = 0

  envVars = {
    ...containerEnv,
    // Forwarded so `opencode serve` (v2) does not generate an ephemeral password.
    ...(opencodePassword ? { OPENCODE_PASSWORD: opencodePassword } : {}),
    PORT: PORT.toString(),
  }

  // v2 serves the event stream on `/api/event`; v1 only knows `/global/event`.
  // v2 answers unknown paths with the SPA HTML, so require an SSE content type.
  private async openEventStream(): Promise<Response> {
    const authorization = containerAuthorization()
    const headers = authorization ? { Authorization: authorization } : undefined

    for (const path of ['/api/event', '/global/event']) {
      const res = await this.containerFetch(`http://container${path}`, {
        headers,
      })
      const contentType = res.headers.get('content-type') ?? ''

      if (res.ok && contentType.includes('text/event-stream')) {
        return res
      }

      console.info(`No event stream at ${path}:`, res.status, contentType)
    }

    throw new Error('No OpenCode event stream endpoint available')
  }

  async watchContainer() {
    try {
      const res = await this.openEventStream()
      const reader = res.body?.getReader()
      if (reader) {
        await processSSEStream(reader, (event) => {
          const eventType = event.type ?? event.data?.type ?? event.payload?.type
          const eventPayload = event.data ?? event.payload
          const now = Date.now()
          const isImmediateActivity = Boolean(eventType && ACTIVITY_EVENTS.has(eventType))
          const isThrottledStreamingActivity = Boolean(
            eventType &&
            STREAMING_ACTIVITY_EVENTS.has(eventType) &&
            now - this._lastRenewedAt >= ACTIVITY_RENEW_INTERVAL_MS,
          )

          if (isImmediateActivity || isThrottledStreamingActivity) {
            this._lastRenewedAt = now
            this.renewActivityTimeout()
            console.info('Renewed container activity timeout')
          }

          if (eventType !== 'message.part.updated') {
            console.info('SSE event:', JSON.stringify(eventPayload))
          }
        })
      }
    } catch (error) {
      console.error('SSE connection error:', error)
      console.info(this._watchPromise)
    }
  }

  override async onStart(): Promise<void> {
    // Fire-and-forget: let SSE listener run in background to avoid blocking blockConcurrencyWhile
    this._watchPromise = this.watchContainer()
  }
}

const SINGLETON_CONTAINER_ID = 'cf-singleton-container'

// The caller already passed the Worker gate, so its credentials are replaced
// with the container credential instead of being forwarded as-is.
function withContainerAuthorization(request: Request): Request {
  const authorization = containerAuthorization()
  if (!authorization) {
    return request
  }

  const headers = new Headers(request.headers)
  headers.set('Authorization', authorization)
  return new Request(request, { headers })
}

export async function forwardRequestToContainer(request: Request) {
  const objectId = env.AGENT_CONTAINER.idFromName(SINGLETON_CONTAINER_ID)
  const container = env.AGENT_CONTAINER.get(objectId, {
    locationHint: 'wnam', // Force west US region
  })

  return container.fetch(withContainerAuthorization(request))
}
