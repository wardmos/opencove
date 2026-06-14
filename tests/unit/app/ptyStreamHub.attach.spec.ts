import { describe, expect, it, vi } from 'vitest'
import { PtyStreamHub } from '../../../src/app/main/controlSurface/ptyStream/ptyStreamHub'

function createWebSocketMock(readyState = 1) {
  const sent: Array<Record<string, unknown>> = []
  const ws = {
    OPEN: 1,
    readyState,
    bufferedAmount: 0,
    send: vi.fn((raw: string) => {
      sent.push(JSON.parse(raw))
    }),
    close: vi.fn(),
  }

  return { ws, sent }
}

function createHub() {
  const runtime = {
    spawnSession: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => () => undefined),
    onExit: vi.fn(() => () => undefined),
  }
  const hub = new PtyStreamHub({ replayWindowMaxBytes: 64_000, ptyRuntime: runtime })

  hub.registerSessionMetadata({
    sessionId: 'session-1',
    kind: 'terminal',
    startedAt: '2026-06-14T00:00:00.000Z',
    cwd: '/tmp',
    command: 'bash',
    args: [],
    cols: 80,
    rows: 24,
  })

  return { hub, runtime }
}

function lastAttachedRole(sent: Array<Record<string, unknown>>): string | undefined {
  const attached = [...sent].reverse().find(message => message.type === 'attached')
  return attached?.role as string | undefined
}

describe('PtyStreamHub attach controller handoff', () => {
  it('promotes a reconnecting client when the previous controller socket is no longer open', () => {
    const { hub, runtime } = createHub()

    // First client takes control, then its socket dies without a processed 'close' (e.g. the desktop
    // force-quit and the half-open socket has not been reaped yet).
    const first = createWebSocketMock()
    hub.registerClient({ clientId: 'client-1', kind: 'desktop', ws: first.ws as never })
    hub.attach({ clientId: 'client-1', sessionId: 'session-1', afterSeq: 0, role: 'controller' })
    expect(lastAttachedRole(first.sent)).toBe('controller')
    first.ws.readyState = 3 // CLOSED

    // The reopened desktop reconnects as a brand-new client and asks for control.
    const second = createWebSocketMock()
    hub.registerClient({ clientId: 'client-2', kind: 'desktop', ws: second.ws as never })
    hub.attach({ clientId: 'client-2', sessionId: 'session-1', afterSeq: 0, role: 'controller' })

    expect(lastAttachedRole(second.sent)).toBe('controller')

    // As controller it can resize without being rejected.
    hub.resize({ clientId: 'client-2', sessionId: 'session-1', cols: 100, rows: 30 })
    expect(runtime.resize).toHaveBeenCalledWith('session-1', 100, 30, 'frame_commit')
    expect(second.sent.some(message => message.type === 'error')).toBe(false)
  })

  it('keeps a second client as viewer while the existing controller socket stays open', () => {
    const { hub, runtime } = createHub()

    const first = createWebSocketMock()
    hub.registerClient({ clientId: 'client-1', kind: 'desktop', ws: first.ws as never })
    hub.attach({ clientId: 'client-1', sessionId: 'session-1', afterSeq: 0, role: 'controller' })

    const second = createWebSocketMock()
    hub.registerClient({ clientId: 'client-2', kind: 'desktop', ws: second.ws as never })
    hub.attach({ clientId: 'client-2', sessionId: 'session-1', afterSeq: 0, role: 'controller' })

    expect(lastAttachedRole(second.sent)).toBe('viewer')

    hub.resize({ clientId: 'client-2', sessionId: 'session-1', cols: 100, rows: 30 })
    expect(runtime.resize).not.toHaveBeenCalled()
    expect(
      second.sent.some(
        message => message.type === 'error' && message.code === 'session.not_controller',
      ),
    ).toBe(true)
  })
})
