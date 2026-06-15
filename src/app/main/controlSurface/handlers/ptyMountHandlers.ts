import { fromFileUri } from '../../../../contexts/filesystem/domain/fileUri'
import type { ApprovedWorkspaceStore } from '../../../../contexts/workspace/infrastructure/approval/ApprovedWorkspaceStore'
import { createAppError, OpenCoveAppError } from '../../../../shared/errors/appError'
import type {
  SpawnTerminalInMountInput,
  SpawnTerminalInput,
  SpawnTerminalResult,
} from '../../../../shared/contracts/dto'
import { TerminalProfileResolver } from '../../../../platform/terminal/TerminalProfileResolver'
import type { ControlSurface } from '../controlSurface'
import type { WorkerTopologyStore } from '../topology/topologyStore'
import { assertFileUriWithinRootUri } from '../topology/fileUriScope'
import type { MultiEndpointPtyRuntime } from '../ptyStream/multiEndpointPtyRuntime'
import type { PtyStreamHub } from '../ptyStream/ptyStreamHub'
import { invokeControlSurface } from '../remote/controlSurfaceHttpClient'
import { normalizeEnvPayload } from '../../ipc/normalize'
import {
  describeControlSurfaceError,
  logControlSurfaceError,
  logControlSurfaceInfo,
} from '../controlSurfaceDiagnostics'

const terminalProfileResolver = new TerminalProfileResolver()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function truncate(value: string, maxLength = 320): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}...<truncated:${value.length}>`
}

function normalizeOptionalString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeRequiredString(value: unknown, debugName: string): string {
  const normalized = normalizeOptionalString(value)
  if (!normalized) {
    throw createAppError('common.invalid_input', { debugMessage: `Missing ${debugName}.` })
  }

  return normalized
}

function normalizeOptionalPositiveInt(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }

  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : null
}

function normalizeOptionalArgs(value: unknown): string[] | null {
  if (value === null || value === undefined) {
    return null
  }

  if (!Array.isArray(value)) {
    return null
  }

  return value.filter((item): item is string => typeof item === 'string')
}

function normalizeFileSystemUri(uri: unknown, operationId: string): string {
  if (typeof uri !== 'string') {
    throw createAppError('common.invalid_input', {
      debugMessage: `Invalid payload for ${operationId} uri.`,
    })
  }

  const normalized = uri.trim()
  if (normalized.length === 0) {
    throw createAppError('common.invalid_input', {
      debugMessage: `Missing payload for ${operationId} uri.`,
    })
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw createAppError('common.invalid_input', {
      debugMessage: `Invalid payload for ${operationId} uri.`,
    })
  }

  if (parsed.protocol !== 'file:') {
    throw createAppError('common.invalid_input', {
      debugMessage: `Unsupported uri scheme for ${operationId}: ${parsed.protocol}`,
    })
  }

  return normalized
}

function normalizeSpawnInMountPayload(payload: unknown): SpawnTerminalInMountInput {
  if (!isRecord(payload)) {
    throw createAppError('common.invalid_input', {
      debugMessage: 'Invalid payload for pty.spawnInMount.',
    })
  }

  return {
    mountId: normalizeRequiredString(payload.mountId, 'pty.spawnInMount mountId'),
    cwdUri:
      payload.cwdUri === undefined || payload.cwdUri === null
        ? null
        : normalizeFileSystemUri(payload.cwdUri, 'pty.spawnInMount cwdUri'),
    profileId: normalizeOptionalString(payload.profileId),
    shell: normalizeOptionalString(payload.shell),
    command: normalizeOptionalString(payload.command),
    args: normalizeOptionalArgs(payload.args),
    cols: normalizeOptionalPositiveInt(payload.cols),
    rows: normalizeOptionalPositiveInt(payload.rows),
    env: normalizeEnvPayload(payload.env) ?? null,
  }
}

function resolvePathFromUriOrThrow(uri: string, operationId: string): string {
  const resolved = fromFileUri(uri)
  if (!resolved) {
    throw createAppError('common.invalid_input', {
      debugMessage: `Invalid payload for ${operationId}.`,
    })
  }

  return resolved
}

async function invokeRemoteValue<TResult>(options: {
  endpoint: { hostname: string; port: number; token: string }
  id: string
  kind: 'query' | 'command'
  payload: unknown
}): Promise<TResult> {
  try {
    const { result } = await invokeControlSurface(options.endpoint, {
      kind: options.kind,
      id: options.id,
      payload: options.payload,
    })

    if (!result) {
      throw createAppError('worker.unavailable')
    }

    if (result.ok === false) {
      throw createAppError(result.error)
    }

    return result.value as TResult
  } catch (error) {
    if (error instanceof OpenCoveAppError) {
      throw error
    }

    throw createAppError('worker.unavailable', {
      debugMessage: error instanceof Error ? `${error.name}: ${error.message}` : undefined,
    })
  }
}

export function registerPtyMountHandlers(
  controlSurface: ControlSurface,
  deps: {
    approvedWorkspaces: ApprovedWorkspaceStore
    topology: WorkerTopologyStore
    ptyRuntime: MultiEndpointPtyRuntime
    ptyStreamHub: PtyStreamHub
  },
): void {
  controlSurface.register('pty.spawnInMount', {
    kind: 'command',
    validate: normalizeSpawnInMountPayload,
    handle: async (ctx, payload): Promise<SpawnTerminalResult> => {
      logControlSurfaceInfo('pty-spawn-in-mount:start', 'Spawning terminal in mount.', {
        mountId: payload.mountId,
        hasCwdUri: !!payload.cwdUri,
        profileId: payload.profileId ?? null,
        shell: payload.shell ?? null,
        hasCommand: !!payload.command,
        argCount: payload.args?.length ?? 0,
        cols: payload.cols ?? null,
        rows: payload.rows ?? null,
        hasEnv: !!payload.env,
      })

      const target = await deps.topology.resolveMountTarget({ mountId: payload.mountId })
      if (!target) {
        logControlSurfaceError(
          'pty-spawn-in-mount:unknown-mount',
          'Mount target could not be resolved.',
          { mountId: payload.mountId },
        )
        throw createAppError('common.invalid_input', {
          debugMessage: `Unknown mountId: ${payload.mountId}`,
        })
      }

      const cwdUri = payload.cwdUri ?? target.rootUri
      try {
        assertFileUriWithinRootUri({
          rootUri: target.rootUri,
          uri: cwdUri,
          debugMessage: 'pty.spawnInMount cwdUri is outside mount root',
        })
      } catch (error) {
        logControlSurfaceError(
          'pty-spawn-in-mount:cwd-outside-root',
          'Requested cwd is outside the mount root.',
          {
            mountId: payload.mountId,
            endpointId: target.endpointId,
            rootUri: truncate(target.rootUri),
            cwdUri: truncate(cwdUri),
            usedDefaultCwd: !payload.cwdUri,
            ...describeControlSurfaceError(error),
          },
        )
        throw error
      }

      const cwd = resolvePathFromUriOrThrow(cwdUri, 'pty.spawnInMount cwdUri')
      logControlSurfaceInfo('pty-spawn-in-mount:cwd-resolved', 'Resolved mount cwd.', {
        mountId: payload.mountId,
        endpointId: target.endpointId,
        cwd: truncate(cwd),
      })
      const cols = payload.cols ?? 80
      const rows = payload.rows ?? 24
      const profileId = normalizeOptionalString(payload.profileId)
      const shell = normalizeOptionalString(payload.shell)

      const startedAt = ctx.now().toISOString()

      if (target.endpointId === 'local') {
        const isApproved = await deps.approvedWorkspaces.isPathApproved(cwd)
        logControlSurfaceInfo('pty-spawn-in-mount:approval-checked', 'Checked workspace approval.', {
          cwd: truncate(cwd),
          isApproved,
        })
        if (!isApproved) {
          logControlSurfaceError(
            'pty-spawn-in-mount:approval-rejected',
            'cwd is outside approved roots.',
            { cwd: truncate(cwd) },
          )
          throw createAppError('common.approved_path_required', {
            debugMessage: 'pty.spawnInMount cwd is outside approved roots',
          })
        }

        const resolvedSpawn = await (payload.command
          ? terminalProfileResolver.resolveCommandSpawn({
              cwd,
              profileId,
              command: payload.command,
              args: payload.args ?? [],
              env: payload.env ?? undefined,
              commandEnv: payload.env ?? undefined,
            })
          : terminalProfileResolver.resolveTerminalSpawn({
              cwd,
              cols,
              rows,
              profileId: profileId ?? undefined,
              ...(shell ? { shell } : {}),
              ...(payload.env ? { env: payload.env } : {}),
            })
        ).catch(error => {
          logControlSurfaceError(
            'pty-spawn-in-mount:spawn-resolve-failed',
            'Failed to resolve terminal spawn.',
            {
              cwd: truncate(cwd),
              profileId,
              shell,
              hasCommand: !!payload.command,
              ...describeControlSurfaceError(error),
            },
          )
          throw error
        })
        logControlSurfaceInfo('pty-spawn-in-mount:spawn-resolved', 'Resolved terminal spawn.', {
          cwd: truncate(resolvedSpawn.cwd),
          command: truncate(resolvedSpawn.command),
          argCount: resolvedSpawn.args.length,
          profileId: resolvedSpawn.profileId,
          runtimeKind: resolvedSpawn.runtimeKind,
        })

        const { sessionId } = await deps.ptyRuntime
          .spawnSession({
            cwd: resolvedSpawn.cwd,
            cols,
            rows,
            command: resolvedSpawn.command,
            args: resolvedSpawn.args,
            env: resolvedSpawn.env,
          })
          .catch(error => {
            logControlSurfaceError('pty-spawn-in-mount:spawn-failed', 'PTY spawn failed.', {
              cwd: truncate(resolvedSpawn.cwd),
              command: truncate(resolvedSpawn.command),
              cols,
              rows,
              ...describeControlSurfaceError(error),
            })
            throw error
          })
        logControlSurfaceInfo('pty-spawn-in-mount:spawned', 'Local terminal session spawned.', {
          sessionId,
          cwd: truncate(resolvedSpawn.cwd),
          runtimeKind: resolvedSpawn.runtimeKind,
        })

        deps.ptyStreamHub.registerSessionMetadata({
          sessionId,
          kind: 'terminal',
          startedAt,
          cwd: resolvedSpawn.cwd,
          command: resolvedSpawn.command,
          args: resolvedSpawn.args,
          cols,
          rows,
        })

        return {
          sessionId,
          profileId: resolvedSpawn.profileId,
          runtimeKind: resolvedSpawn.runtimeKind,
        }
      }

      logControlSurfaceInfo(
        'pty-spawn-in-mount:remote-dispatch',
        'Dispatching terminal spawn to remote endpoint.',
        { endpointId: target.endpointId, cwd: truncate(cwd) },
      )
      const endpoint = await deps.topology.resolveRemoteEndpointConnection(target.endpointId)
      if (!endpoint) {
        logControlSurfaceError(
          'pty-spawn-in-mount:remote-endpoint-unavailable',
          'Remote endpoint connection is unavailable.',
          { endpointId: target.endpointId },
        )
        throw createAppError('worker.unavailable', {
          debugMessage: `Remote endpoint unavailable: ${target.endpointId}`,
        })
      }

      const remoteSpawnPayload: SpawnTerminalInput = {
        cwd,
        cols,
        rows,
        ...(profileId ? { profileId } : {}),
        ...(shell ? { shell } : {}),
        ...(payload.command ? { command: payload.command } : {}),
        ...(payload.args ? { args: payload.args } : {}),
        ...(payload.env ? { env: payload.env } : {}),
      }

      const remoteResult = await invokeRemoteValue<SpawnTerminalResult>({
        endpoint,
        kind: 'command',
        id: 'pty.spawn',
        payload: remoteSpawnPayload,
      }).catch(error => {
        logControlSurfaceError(
          'pty-spawn-in-mount:remote-spawn-failed',
          'Remote pty.spawn invocation failed.',
          { endpointId: target.endpointId, cwd: truncate(cwd), ...describeControlSurfaceError(error) },
        )
        throw error
      })

      const remoteSessionId = normalizeOptionalString(remoteResult.sessionId)
      if (!remoteSessionId) {
        logControlSurfaceError(
          'pty-spawn-in-mount:remote-invalid-session',
          'Remote pty.spawn returned an invalid session id.',
          { endpointId: target.endpointId },
        )
        throw createAppError('worker.unavailable', {
          debugMessage: 'Remote pty.spawn returned an invalid session id.',
        })
      }

      const homeSessionId = deps.ptyRuntime.registerRemoteSession({
        endpointId: target.endpointId,
        remoteSessionId,
      })
      logControlSurfaceInfo('pty-spawn-in-mount:remote-spawned', 'Remote terminal session spawned.', {
        endpointId: target.endpointId,
        sessionId: homeSessionId,
        remoteSessionId,
      })

      deps.ptyStreamHub.registerSessionMetadata({
        sessionId: homeSessionId,
        kind: 'terminal',
        startedAt,
        cwd,
        command: payload.command ?? shell ?? 'shell',
        args: payload.command ? (payload.args ?? []) : [],
        cols,
        rows,
      })

      return {
        sessionId: homeSessionId,
        profileId: remoteResult.profileId ?? profileId,
        runtimeKind: remoteResult.runtimeKind,
      }
    },
    defaultErrorCode: 'terminal.spawn_failed',
  })
}
