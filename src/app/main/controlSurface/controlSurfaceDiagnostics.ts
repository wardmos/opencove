import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { OpenCoveAppError } from '../../../shared/errors/appError'
import type { RuntimeDiagnosticsDetailValue } from '../../../shared/contracts/dto'

// Control-surface diagnostics are always on (no env toggle): the terminal-launch
// path is the primary support pain point, so we want the trace available without
// asking users to reproduce with a flag set.
function truncate(value: string, maxLength = 500): string {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}...<truncated:${value.length}>`
}

function appendRuntimeDiagnosticsFile(line: string): void {
  try {
    const filePath = resolve(app.getPath('userData'), 'logs', 'runtime-diagnostics.log')
    mkdirSync(dirname(filePath), { recursive: true })
    appendFileSync(filePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // Diagnostics logging must never affect app runtime behavior.
  }
}

function writeControlSurfaceDiagnosticsLine(
  level: 'info' | 'error',
  event: string,
  message: string,
  details?: Record<string, RuntimeDiagnosticsDetailValue>,
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    source: 'main-app',
    level,
    event: `control-surface:${event}`,
    message,
    ...(details ? { details } : {}),
  })
  const stream = level === 'error' ? process.stderr : process.stdout
  stream.write(`[opencove-control-surface] ${line}\n`)
  appendRuntimeDiagnosticsFile(line)
}

// Surfaces the fields that actually explain a failure: for OpenCoveAppError the
// localized message is generic ("The request was invalid."), so the `code` and
// `debugMessage` carry the real reason. Plain errors fall back to name/stack.
export function describeControlSurfaceError(
  error: unknown,
): Record<string, RuntimeDiagnosticsDetailValue> {
  if (error instanceof OpenCoveAppError) {
    return {
      errorKind: 'app-error',
      errorCode: error.code,
      errorDebugMessage: error.debugMessage ? truncate(error.debugMessage, 500) : null,
      errorName: error.name,
      errorMessage: truncate(error.message, 500),
      errorStack: error.stack ? truncate(error.stack, 1200) : null,
    }
  }

  if (error instanceof Error) {
    return {
      errorKind: 'error',
      errorCode: null,
      errorDebugMessage: null,
      errorName: error.name,
      errorMessage: truncate(error.message, 500),
      errorStack: error.stack ? truncate(error.stack, 1200) : null,
    }
  }

  return {
    errorKind: 'unknown',
    errorCode: null,
    errorDebugMessage: null,
    errorName: null,
    errorMessage: truncate(String(error), 500),
    errorStack: null,
  }
}

export function logControlSurfaceInfo(
  event: string,
  message: string,
  details?: Record<string, RuntimeDiagnosticsDetailValue>,
): void {
  writeControlSurfaceDiagnosticsLine('info', event, message, details)
}

export function logControlSurfaceError(
  event: string,
  message: string,
  details?: Record<string, RuntimeDiagnosticsDetailValue>,
): void {
  writeControlSurfaceDiagnosticsLine('error', event, message, details)
}
