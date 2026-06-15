import React, { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_SETTINGS } from '../../../src/contexts/settings/domain/agentSettings'
import type { WorkspaceState } from '../../../src/contexts/workspace/presentation/renderer/types'
import { installMockStorage } from '../../support/persistenceTestStorage'

function createPersistedState() {
  return {
    activeWorkspaceId: 'workspace-1',
    workspaces: [
      {
        id: 'workspace-1',
        name: 'Workspace 1',
        path: '/tmp/workspace-1',
        worktreesRoot: '/tmp/workspace-1',
        environmentVariables: {},
        pullRequestBaseBranchOptions: [],
        spaceArchiveRecords: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        isMinimapVisible: false,
        spaces: [],
        activeSpaceId: null,
        nodes: [
          {
            id: 'terminal-node-1',
            title: 'zsh',
            position: { x: 0, y: 0 },
            width: 520,
            height: 360,
            kind: 'terminal',
            sessionId: 'old-session-id',
            status: 'running',
            startedAt: '2026-04-24T10:00:00.000Z',
            endedAt: null,
            exitCode: null,
            lastError: null,
            scrollback: 'persisted terminal output',
            profileId: null,
            terminalGeometry: { cols: 80, rows: 24 },
            agent: null,
            task: null,
          },
        ],
      },
    ],
    settings: {},
  }
}

function revivedTerminalNode() {
  return {
    nodeId: 'terminal-node-1',
    kind: 'terminal' as const,
    recoveryState: 'live' as const,
    sessionId: 'revived-session-id',
    isLiveSessionReattach: true,
    title: 'zsh',
    profileId: null,
    runtimeKind: 'posix' as const,
    status: 'running' as const,
    startedAt: '2026-04-24T10:00:00.000Z',
    endedAt: null,
    exitCode: null,
    lastError: null,
    scrollback: 'persisted terminal output',
    executionDirectory: '/tmp/workspace-1',
    expectedDirectory: '/tmp/workspace-1',
    terminalGeometry: { cols: 80, rows: 24 },
    agent: null,
  }
}

function createHarness(
  useHydrateAppStateHook: typeof import('../../../src/app/renderer/shell/hooks/useHydrateAppState').useHydrateAppState,
) {
  return function Harness() {
    const [_agentSettings, setAgentSettings] = useState(DEFAULT_AGENT_SETTINGS)
    const [workspaces, setWorkspaces] = useState<WorkspaceState[]>([])
    const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)

    const { isHydrated } = useHydrateAppStateHook({
      activeWorkspaceId,
      setAgentSettings,
      setWorkspaces,
      setActiveWorkspaceId,
    })

    const terminal = workspaces.find(workspace => workspace.id === 'workspace-1')?.nodes[0]

    return (
      <div>
        <div data-testid="hydrated">{String(isHydrated)}</div>
        <div data-testid="terminal-session-id">{terminal?.data.sessionId ?? ''}</div>
        <div data-testid="terminal-live-reattach">
          {String(terminal?.data.isLiveSessionReattach === true)}
        </div>
      </div>
    )
  }
}

function installOpencoveApi(controlSurfaceInvoke: (request: unknown) => Promise<unknown>): void {
  Object.defineProperty(window, 'opencoveApi', {
    configurable: true,
    writable: true,
    value: {
      meta: {
        runtime: 'electron',
        platform: 'darwin',
        isTest: true,
        isPackaged: false,
        allowWhatsNewInTests: true,
        mainPid: 123,
        windowsPty: null,
      },
      controlSurface: { invoke: controlSurfaceInvoke },
      pty: {
        spawn: vi.fn(async () => ({ sessionId: 'should-not-spawn' })),
        snapshot: vi.fn(async () => ({ data: 'legacy snapshot' })),
      },
      agent: {
        launch: vi.fn(async () => ({ sessionId: 'should-not-launch' })),
        resolveResumeSessionId: vi.fn(async () => ({ resumeSessionId: null })),
      },
    },
  })
}

describe('useHydrateAppState terminal revive retry', () => {
  it('reattaches a restored terminal after the first prepareOrRevive pass fails', async () => {
    const storage = installMockStorage()
    storage.setItem('opencove:m0:workspace-state', JSON.stringify(createPersistedState()))

    let calls = 0
    const controlSurfaceInvoke = vi.fn(async () => {
      calls += 1
      if (calls === 1) {
        // Mirrors the real failure: the remote worker connection is not ready on first attempt.
        throw new Error('worker unavailable')
      }
      return { workspaceId: 'workspace-1', nodes: [revivedTerminalNode()] }
    })

    installOpencoveApi(controlSurfaceInvoke)

    const { useHydrateAppState } =
      await import('../../../src/app/renderer/shell/hooks/useHydrateAppState')

    render(React.createElement(createHarness(useHydrateAppState)))

    // Startup completes immediately even though the first revive failed (non-blocking).
    await waitFor(() => {
      expect(screen.getByTestId('hydrated')).toHaveTextContent('true')
    })
    expect(screen.getByTestId('terminal-session-id')).toHaveTextContent('')

    // The background watchdog retries and reattaches the still-live session.
    await waitFor(
      () => {
        expect(screen.getByTestId('terminal-session-id')).toHaveTextContent('revived-session-id')
      },
      { timeout: 5_000 },
    )
    expect(screen.getByTestId('terminal-live-reattach')).toHaveTextContent('true')
    expect(controlSurfaceInvoke.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
