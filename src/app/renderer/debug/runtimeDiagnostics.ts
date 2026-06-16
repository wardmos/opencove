type TerminalReviveDetailValue = string | number | boolean | null

// Traces the terminal restore/revive/attach flow on app reopen so the path can
// be followed in the `pnpm dev` terminal (forwarded to the main process and
// printed as [opencove-runtime-diagnostics] lines).
export function logTerminalReviveDiagnostic(
  event: string,
  message: string,
  details?: Record<string, TerminalReviveDetailValue>,
  level: 'info' | 'error' = 'info',
): void {
  window.opencoveApi.debug?.logRuntimeDiagnostics?.({
    source: 'renderer-terminal-revive',
    level,
    event,
    message,
    ...(details ? { details } : {}),
  })
}

export function logRendererErrorBoundaryDiagnostic(
  error: Error,
  errorInfo: Pick<React.ErrorInfo, 'componentStack'>,
): void {
  window.opencoveApi.debug?.logRuntimeDiagnostics?.({
    source: 'renderer-error-boundary',
    level: 'error',
    event: 'component-did-catch',
    message: 'Renderer error boundary caught an uncaught error.',
    details: {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack ?? null,
      componentStack: errorInfo.componentStack || null,
    },
  })
}
