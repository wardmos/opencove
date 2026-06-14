import { describe, expect, it, vi } from 'vitest'
import { PtyStreamHub } from '../../../src/app/main/controlSurface/ptyStream/ptyStreamHub'

function createWebSocketMock() {
  const sent: Array<Record<string, unknown>> = []
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((raw: string) => {
      sent.push(JSON.parse(raw) as Record<string, unknown>)
    }),
    close: vi.fn(),
  }

  return { ws, sent }
}

function createHub(runtimeOverrides: Partial<Parameters<typeof createHubRuntime>[0]> = {}) {
  return new PtyStreamHub({
    replayWindowMaxBytes: 64_000,
    ptyRuntime: createHubRuntime(runtimeOverrides),
  })
}

function createHubRuntime(overrides: Record<string, unknown> = {}) {
  return {
    spawnSession: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => () => undefined),
    onExit: vi.fn(() => () => undefined),
    ...overrides,
  } as never
}

function registerSession(hub: PtyStreamHub, sessionId: string): void {
  hub.registerSessionMetadata({
    sessionId,
    kind: 'agent',
    startedAt: '2026-04-29T00:00:00.000Z',
    cwd: '/tmp',
    command: 'codex',
    args: [],
    cols: 80,
    rows: 24,
  })
}

describe('PtyStreamHub attach controller lifecycle', () => {
  it('evicts a stale controller whose socket is closed so a reconnecting client gains control', () => {
    const runtimeResize = vi.fn()
    const hub = createHub({ resize: runtimeResize })
    const previous = createWebSocketMock()
    const next = createWebSocketMock()

    hub.registerClient({ clientId: 'previous', kind: 'desktop', ws: previous.ws as never })
    registerSession(hub, 'session-1')
    hub.attach({ clientId: 'previous', sessionId: 'session-1', role: 'controller' })

    // The previous client's process is gone but its TCP close has not been processed yet:
    // the client is still registered, only its socket is no longer open.
    previous.ws.readyState = 3

    hub.registerClient({ clientId: 'next', kind: 'desktop', ws: next.ws as never })
    next.sent.length = 0
    hub.attach({ clientId: 'next', sessionId: 'session-1', role: 'controller' })

    const attached = next.sent.find(message => message.type === 'attached')
    expect(attached?.role).toBe('controller')

    // A controller can resize; the reconnecting client must therefore not be rejected.
    next.sent.length = 0
    hub.resize({
      clientId: 'next',
      sessionId: 'session-1',
      cols: 100,
      rows: 40,
      reason: 'frame_commit',
    })

    expect(next.sent.some(message => message.type === 'error')).toBe(false)
    expect(runtimeResize).toHaveBeenCalledWith('session-1', 100, 40, 'frame_commit')
  })

  it('keeps a live controller so a second client attaches as a viewer', () => {
    const hub = createHub()
    const controller = createWebSocketMock()
    const viewer = createWebSocketMock()

    hub.registerClient({ clientId: 'controller', kind: 'desktop', ws: controller.ws as never })
    registerSession(hub, 'session-1')
    hub.attach({ clientId: 'controller', sessionId: 'session-1', role: 'controller' })

    hub.registerClient({ clientId: 'viewer', kind: 'desktop', ws: viewer.ws as never })
    viewer.sent.length = 0
    hub.attach({ clientId: 'viewer', sessionId: 'session-1', role: 'controller' })

    const attached = viewer.sent.find(message => message.type === 'attached')
    expect(attached?.role).toBe('viewer')

    // The live controller is unchanged, so the viewer's resize is rejected.
    viewer.sent.length = 0
    hub.resize({
      clientId: 'viewer',
      sessionId: 'session-1',
      cols: 100,
      rows: 40,
      reason: 'frame_commit',
    })

    expect(
      viewer.sent.some(
        message => message.type === 'error' && message.code === 'session.not_controller',
      ),
    ).toBe(true)
  })
})
