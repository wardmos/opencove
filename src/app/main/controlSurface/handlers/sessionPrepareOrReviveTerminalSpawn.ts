import { stat } from 'node:fs/promises'
import { toFileUri } from '../../../../contexts/filesystem/domain/fileUri'
import { resolveSpaceMountContext } from '../../../../contexts/space/application/resolveSpaceMountContext'
import { createAppError } from '../../../../shared/errors/appError'
import type { MountDto, SpawnTerminalResult } from '../../../../shared/contracts/dto'
import type { ControlSurface } from '../controlSurface'
import type { ControlSurfaceContext } from '../types'
import { invokeCommand } from './sessionPrepareOrReviveShared'
import { logControlSurfaceInfo } from '../controlSurfaceDiagnostics'
import {
  DEFAULT_PTY_COLS,
  DEFAULT_PTY_ROWS,
  type PtyGeometry,
} from './sessionPrepareOrReviveGeometry'
import type {
  NormalizedPersistedSpace,
  NormalizedPersistedWorkspace,
} from './sessionPrepareOrReviveShared'

export type PrepareOrReviveLaunchContext = {
  mountId: string | null
  workingDirectory: string
}

async function listWorkspaceMounts(options: {
  controlSurface: ControlSurface
  ctx: ControlSurfaceContext
  workspaceId: string
}): Promise<MountDto[]> {
  try {
    const result = await options.controlSurface.invoke(options.ctx, {
      kind: 'query',
      id: 'mount.list',
      payload: { projectId: options.workspaceId },
    })

    if (result.ok === false) {
      return []
    }

    const value = result.value as { mounts?: unknown }
    return Array.isArray(value.mounts) ? (value.mounts as MountDto[]) : []
  } catch {
    return []
  }
}

export async function resolvePrepareOrReviveLaunchContext(options: {
  controlSurface: ControlSurface
  ctx: ControlSurfaceContext
  workspace: NormalizedPersistedWorkspace
  space: NormalizedPersistedSpace | null
  cwd: string
}): Promise<PrepareOrReviveLaunchContext> {
  const mounts = await listWorkspaceMounts({
    controlSurface: options.controlSurface,
    ctx: options.ctx,
    workspaceId: options.workspace.id,
  })
  // Infer the mount from the terminal's cwd even when it has no owning space (or
  // its persisted targetMountId churned across reopen): resolveSpaceMountContext
  // matches a mount whose rootPath contains the cwd. Without this, a remote
  // terminal with no space fell through to a local pty.spawn with a remote cwd.
  const resolved = resolveSpaceMountContext({
    space: {
      directoryPath: options.cwd,
      targetMountId: options.space?.targetMountId ?? null,
      boundary: options.space?.boundary ?? null,
    },
    workspacePath: options.workspace.path,
    mounts,
  })

  logControlSurfaceInfo('revive-mount:resolve', 'Resolved mount for terminal revive.', {
    cwd: options.cwd,
    hasSpace: !!options.space,
    targetMountId: options.space?.targetMountId ?? null,
    mountCount: mounts.length,
    resolvedMountId: resolved.mount?.mountId ?? null,
    mountRoots: mounts
      .map(mount => mount.rootPath)
      .join(',')
      .slice(0, 300),
  })

  return {
    mountId: resolved.mount?.mountId ?? null,
    workingDirectory: resolved.workingDirectory,
  }
}

// On reopen, revive can race ahead of remote endpoint/mount registration, so a
// remote terminal's mount is briefly absent from mount.list. Wait a bounded
// while for it to appear before giving up (rather than spawning a doomed local
// shell). resolveSpaceMountContext matches the mount by cwd, so this also
// recovers when the persisted targetMountId churned to a new id across reopens.
const MOUNT_WAIT_ATTEMPTS = 8
const MOUNT_WAIT_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

async function directoryExistsLocally(path: string): Promise<boolean> {
  return stat(path)
    .then(entry => entry.isDirectory())
    .catch(() => false)
}

export async function spawnFallbackTerminal(options: {
  controlSurface: ControlSurface
  ctx: ControlSurfaceContext
  workspace: NormalizedPersistedWorkspace
  space: NormalizedPersistedSpace | null
  cwd: string
  profileId: string | null
  geometry?: PtyGeometry
}): Promise<SpawnTerminalResult & { cwd: string }> {
  const geometry = options.geometry ?? { cols: DEFAULT_PTY_COLS, rows: DEFAULT_PTY_ROWS }
  const resolveLaunchContext = (): Promise<PrepareOrReviveLaunchContext> =>
    resolvePrepareOrReviveLaunchContext({
      controlSurface: options.controlSurface,
      ctx: options.ctx,
      workspace: options.workspace,
      space: options.space,
      cwd: options.cwd,
    })

  let launchContext = await resolveLaunchContext()

  // When the mount is unresolved AND the cwd does not exist on this host, this is
  // a remote terminal whose mount has not registered yet (or whose persisted
  // mount id churned across reopen). Spawning a local shell here would chdir into
  // a non-existent directory and exit 1 immediately. Wait briefly for the mount
  // to come up so we can route to the remote endpoint instead.
  const cwdMissingLocally =
    !launchContext.mountId && !(await directoryExistsLocally(launchContext.workingDirectory))
  if (cwdMissingLocally) {
    /* eslint-disable no-await-in-loop -- intentional sequential poll with backoff */
    for (let attempt = 0; attempt < MOUNT_WAIT_ATTEMPTS && !launchContext.mountId; attempt += 1) {
      await sleep(MOUNT_WAIT_DELAY_MS)
      launchContext = await resolveLaunchContext()
    }
    /* eslint-enable no-await-in-loop */
  }

  logControlSurfaceInfo('revive-spawn:context', 'Resolved terminal revive launch context.', {
    requestedCwd: options.cwd,
    resolvedWorkingDirectory: launchContext.workingDirectory,
    mountId: launchContext.mountId,
    route: launchContext.mountId ? 'pty.spawnInMount' : 'pty.spawn',
    hasSpace: !!options.space,
    cwdMissingLocally,
    profileId: options.profileId,
  })

  // Remote terminal whose mount never became available: refuse to spawn a local
  // shell with a remote cwd (a guaranteed exit-1 dead shell). Throwing lets
  // prepareTerminalNode return a non-spawned "needs revive" state instead.
  if (cwdMissingLocally && !launchContext.mountId) {
    throw createAppError('worker.unavailable', {
      debugMessage:
        'revive: remote terminal mount unavailable; not spawning local shell for cwd ' +
        launchContext.workingDirectory,
    })
  }

  if (launchContext.mountId) {
    const spawned = await invokeCommand<SpawnTerminalResult>(options.controlSurface, options.ctx, {
      id: 'pty.spawnInMount',
      payload: {
        mountId: launchContext.mountId,
        cwdUri: toFileUri(launchContext.workingDirectory),
        profileId: options.profileId,
        cols: geometry.cols,
        rows: geometry.rows,
      },
    })
    return { ...spawned, cwd: launchContext.workingDirectory }
  }

  const spawned = await invokeCommand<SpawnTerminalResult>(options.controlSurface, options.ctx, {
    id: 'pty.spawn',
    payload: {
      cwd: launchContext.workingDirectory,
      profileId: options.profileId,
      cols: geometry.cols,
      rows: geometry.rows,
    },
  })
  return { ...spawned, cwd: launchContext.workingDirectory }
}
