import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronState = vi.hoisted(() => {
  const contentsById = new Map<
    number,
    {
      destroyed: (() => void) | null
    }
  >()

  return {
    contentsById,
    fromId: vi.fn((id: number) => {
      const content = contentsById.get(id)
      if (!content) {
        return null
      }

      return {
        isDestroyed: () => false,
        getType: () => 'window',
        once: (event: string, listener: () => void) => {
          if (event === 'destroyed') {
            content.destroyed = listener
          }
        },
      }
    }),
  }
})

vi.mock('electron', () => ({
  webContents: {
    fromId: electronState.fromId,
  },
}))

import { createRemotePtySessionCoordinator } from '../../../src/app/main/controlSurface/remote/remotePtyRuntime.sessionCoordinator'

function createMockSocket() {
  return {
    send: vi.fn(),
  }
}

describe('remotePtyRuntime session coordinator', () => {
  beforeEach(() => {
    electronState.contentsById.clear()
    electronState.fromId.mockClear()
  })

  it('keeps a tracked session attached when the last window subscriber is destroyed', async () => {
    const sendDetachMessage = vi.fn(async () => undefined)
    const coordinator = createRemotePtySessionCoordinator({
      connectTimeoutMs: 50,
      cancelMetadataWatcher: vi.fn(),
      shouldKeepSocketAlive: () => true,
      closeSocket: vi.fn(),
      sendDetachMessage,
    })
    const socket = createMockSocket()

    electronState.contentsById.set(1, { destroyed: null })

    coordinator.noteSessionRolePreference('session-1', 'controller')
    coordinator.trackWebContentsDestroyed(1)
    coordinator.addSubscriber(1, 'session-1')
    coordinator.sendAttachForSession(socket as never, 'session-1')
    coordinator.onSessionAttached('session-1')

    await expect(coordinator.waitForSessionAttached('session-1')).resolves.toBeUndefined()

    electronState.contentsById.get(1)?.destroyed?.()

    expect(sendDetachMessage).not.toHaveBeenCalled()
    expect(coordinator.hasTrackedSession('session-1')).toBe(true)
    await expect(coordinator.waitForSessionAttached('session-1')).resolves.toBeUndefined()
  })

  it('clears stale attach state once an untracked session loses its last subscriber', async () => {
    const sendDetachMessage = vi.fn(async () => undefined)
    const coordinator = createRemotePtySessionCoordinator({
      connectTimeoutMs: 50,
      cancelMetadataWatcher: vi.fn(),
      shouldKeepSocketAlive: () => true,
      closeSocket: vi.fn(),
      sendDetachMessage,
    })
    const firstSocket = createMockSocket()
    const secondSocket = createMockSocket()

    coordinator.noteSessionRolePreference('session-1', 'controller')
    coordinator.addSubscriber(1, 'session-1')
    coordinator.sendAttachForSession(firstSocket as never, 'session-1')
    coordinator.onSessionAttached('session-1')

    coordinator.untrackSession('session-1')
    await coordinator.removeSubscriber(1, 'session-1')

    expect(sendDetachMessage).toHaveBeenCalledWith('session-1')

    coordinator.noteSessionRolePreference('session-1', 'controller')
    coordinator.sendAttachForSession(secondSocket as never, 'session-1')

    expect(secondSocket.send).toHaveBeenCalledTimes(1)
  })

  it('re-sends an attach for a tracked session after the attach ack times out', async () => {
    const coordinator = createRemotePtySessionCoordinator({
      connectTimeoutMs: 10,
      cancelMetadataWatcher: vi.fn(),
      shouldKeepSocketAlive: () => true,
      closeSocket: vi.fn(),
      sendDetachMessage: vi.fn(async () => undefined),
    })
    const socket = createMockSocket()

    coordinator.trackSession('session-1')
    coordinator.sendAttachForSession(socket as never, 'session-1')
    expect(socket.send).toHaveBeenCalledTimes(1)

    // No ack arrives: the wait rejects and the in-flight marker is cleared. The session is
    // still tracked and unattached on the same open socket, so a re-drive must actually
    // re-send rather than being suppressed forever (the frozen-restored-terminal bug).
    await expect(coordinator.waitForSessionAttached('session-1')).rejects.toThrow()

    coordinator.sendAttachForSession(socket as never, 'session-1')
    expect(socket.send).toHaveBeenCalledTimes(2)
  })

  it('does not re-send an attach for a session that became attached after its wait timed out', async () => {
    const coordinator = createRemotePtySessionCoordinator({
      connectTimeoutMs: 10,
      cancelMetadataWatcher: vi.fn(),
      shouldKeepSocketAlive: () => true,
      closeSocket: vi.fn(),
      sendDetachMessage: vi.fn(async () => undefined),
    })
    const socket = createMockSocket()

    coordinator.trackSession('session-1')
    coordinator.sendAttachForSession(socket as never, 'session-1')
    await expect(coordinator.waitForSessionAttached('session-1')).rejects.toThrow()

    // A late ack confirms the server already added this client to the session subscribers.
    coordinator.onSessionAttached('session-1')

    // Gating on the "attached" set (not only the in-flight marker) prevents a duplicate attach
    // frame here, which would otherwise trigger a redundant server-side replay.
    coordinator.sendAttachForSession(socket as never, 'session-1')
    expect(socket.send).toHaveBeenCalledTimes(1)
  })
})
