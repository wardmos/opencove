import { toAppErrorDescriptor } from '../../../shared/errors/appError'
import type {
  ControlSurfaceInvokeRequest,
  ControlSurfaceInvokeResult,
} from '../../../shared/contracts/controlSurface'
import type { ControlSurfaceContext, ControlSurfaceHandler } from './types'
import {
  describeControlSurfaceError,
  logControlSurfaceError,
  logControlSurfaceInfo,
} from './controlSurfaceDiagnostics'

export interface ControlSurface {
  register: <TPayload, TResult>(
    id: string,
    handler: ControlSurfaceHandler<TPayload, TResult>,
  ) => void
  invoke: (
    ctx: ControlSurfaceContext,
    request: ControlSurfaceInvokeRequest,
  ) => Promise<ControlSurfaceInvokeResult<unknown>>
}

export function createControlSurface(): ControlSurface {
  const handlers = new Map<string, ControlSurfaceHandler<unknown, unknown>>()

  return {
    register: (id, handler) => {
      if (handlers.has(id)) {
        throw new Error(`Control surface handler already registered: ${id}`)
      }

      handlers.set(id, handler as ControlSurfaceHandler<unknown, unknown>)
    },
    invoke: async (ctx, request) => {
      logControlSurfaceInfo('invoke:start', 'Control surface invoke received.', {
        id: request.id,
        kind: request.kind,
      })

      const handler = handlers.get(request.id)
      if (!handler || handler.kind !== request.kind) {
        logControlSurfaceError('invoke:unknown-handler', 'No handler matched the request.', {
          id: request.id,
          kind: request.kind,
          handlerRegistered: !!handler,
          registeredKind: handler ? handler.kind : null,
        })
        return {
          __opencoveControlEnvelope: true,
          ok: false,
          error: toAppErrorDescriptor(
            new Error(`Unknown control surface ${request.kind}: ${request.id}`),
            'common.invalid_input',
          ),
        }
      }

      // Track which phase failed so a `common.invalid_input` raised while
      // validating the payload is distinguishable from one raised inside the
      // handler body.
      let phase: 'validate' | 'handle' = 'validate'
      try {
        const payload = handler.validate(request.payload)
        phase = 'handle'
        const value = await handler.handle(ctx, payload)

        logControlSurfaceInfo('invoke:succeeded', 'Control surface invoke succeeded.', {
          id: request.id,
          kind: request.kind,
        })
        return {
          __opencoveControlEnvelope: true,
          ok: true,
          value,
        }
      } catch (error) {
        const descriptor = toAppErrorDescriptor(error, handler.defaultErrorCode)
        logControlSurfaceError('invoke:failed', 'Control surface invoke failed.', {
          id: request.id,
          kind: request.kind,
          phase,
          resolvedErrorCode: descriptor.code,
          ...describeControlSurfaceError(error),
        })
        return {
          __opencoveControlEnvelope: true,
          ok: false,
          error: descriptor,
        }
      }
    },
  }
}
