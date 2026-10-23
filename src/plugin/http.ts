/**
 * Read-only HTTP surface for the block tree.
 *
 * Mounted as an **exact fetch route** under the shared `/api` prefix. That is the
 * only safe extension point: the channel carries a single `intercept` slot owned by
 * the Typert gateway, and registering there replaces the gateway so every other RPC
 * answers 404. Exact routes are matched before that interceptor, so this handler
 * cannot shadow a shipped endpoint.
 *
 * @module dsh-token-tree/plugin/http
 */

import type { ContextLike, ConnectionLike } from './dsh.ts'
import { agentRegistryOf } from './dsh.ts'
import type { TokenTreeService } from './service.ts'
import { blocksOf, nodesOf } from './blocks.ts'
import type { NodesPayload, TreePayload } from './blocks.ts'

/** Route path, below the shared `/api` prefix. */
export const TREE_ROUTE = '/api/token-tree/tree'

/** Write route: anchor the next turn on a node the user picked. */
export const FOCUS_ROUTE = '/api/token-tree/focus'

/** Write route: structural edits from the editor. */
export const EDIT_ROUTE = '/api/token-tree/edit'

/** Read/write route: the switches that can be flipped while the host runs. */
export const SETTINGS_ROUTE = '/api/token-tree/settings'

/** Empty payload used before any session exists. */
function emptyPayload(): TreePayload {
  return {
    sessionId: '',
    focusId: '',
    stats: { blocks: 0, branches: 0, maxDepth: 0, tokens: 0 },
    constraints: [],
    blocks: [],
  }
}

/** Empty node payload used before any session exists. */
function emptyNodesPayload(): NodesPayload {
  return {
    sessionId: '',
    focusId: '',
    hidden: [],
    stats: { nodes: 0, questions: 0, answers: 0, tools: 0, maxDepth: 0, branches: 0, tokens: 0 },
    constraints: [],
    nodes: [],
  }
}

/**
 * Mount the read-only tree surface when the host exposes a web connection.
 * @param ctx - plugin context.
 * @param service - session memory service.
 */
export function installHttpRoute(ctx: ContextLike, service: TokenTreeService): void {
  const register = (scoped: ContextLike): void => {
    const connection: ConnectionLike | undefined = scoped.connection
    if (connection === undefined) return

    scoped.effect(() => connection.fetch.register({
      path: TREE_ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url)
        const requested = url.searchParams.get('session') ?? ''
        const sessionId = requested.length > 0 ? requested : (service.sessionIds.at(-1) ?? '')
        const agent = sessionId.length > 0 ? agentRegistryOf(ctx)?.get(sessionId) : undefined
        if (agent !== undefined) service.backfillFromSession(agent.session)
        // `view=nodes` is the editor's full-tree mode: every node, not just blocks.
        const wantsNodes = url.searchParams.get('view') === 'nodes'
        const tree = sessionId.length > 0 ? service.treeOf(sessionId) : undefined
        const payload = tree === undefined
          ? (wantsNodes ? emptyNodesPayload() : emptyPayload())
          : wantsNodes
            ? nodesOf(tree, {
              constraints: service.constraintsOf(sessionId),
              anchoredId: service.anchoredNode(sessionId),
            })
            : {
              ...blocksOf(tree, {
                constraints: service.constraintsOf(sessionId),
                anchoredId: service.anchoredNode(sessionId),
              }),
              ...(requested.length > 0 ? { requested } : {}),
            }
        if (request.method === 'HEAD') return new Response(null, { status: 200 })
        return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
      },
    }), 'token-tree: /api/token-tree/tree')
    ctx.logger.info(`token-tree: serving ${TREE_ROUTE}`)

    // The editor writes through this route: it anchors the next turn on a node the
    // user picked, which is the manual half of branching.
    scoped.effect(() => connection.fetch.register({
      path: FOCUS_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        let body: { session?: unknown; nodeId?: unknown; clear?: unknown }
        try {
          body = await request.json() as typeof body
        } catch {
          return Response.json({ ok: false, error: 'body must be json' }, { status: 400 })
        }
        const requested = typeof body.session === 'string' ? body.session : ''
        const sessionId = requested.length > 0 ? requested : (service.sessionIds.at(-1) ?? '')
        if (sessionId.length === 0) return Response.json({ ok: false, error: 'no session' }, { status: 409 })
        if (body.clear === true) {
          service.unfocus(sessionId)
          return Response.json({ ok: true, anchored: null }, { headers: { 'cache-control': 'no-store' } })
        }
        if (typeof body.nodeId !== 'string' || body.nodeId.length === 0) {
          return Response.json({ ok: false, error: 'nodeId is required' }, { status: 400 })
        }
        try {
          const anchored = service.focus(sessionId, body.nodeId)
          ctx.logger.info(`token-tree: next turn anchored on ${body.nodeId} (session ${sessionId})`)
          return Response.json({ ok: true, anchored }, { headers: { 'cache-control': 'no-store' } })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 404 },
          )
        }
      },
    }), 'token-tree: /api/token-tree/focus')
    ctx.logger.info(`token-tree: serving ${FOCUS_ROUTE}`)

    // Structural edits from the editor: move a branch, delete a subtree, mark a node.
    scoped.effect(() => connection.fetch.register({
      path: EDIT_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        let body: { session?: unknown; action?: unknown; nodeId?: unknown; parentId?: unknown; pinned?: unknown; ignored?: unknown }
        try {
          body = await request.json() as typeof body
        } catch {
          return Response.json({ ok: false, error: 'body must be json' }, { status: 400 })
        }
        const requested = typeof body.session === 'string' ? body.session : ''
        const sessionId = requested.length > 0 ? requested : (service.sessionIds.at(-1) ?? '')
        if (sessionId.length === 0) return Response.json({ ok: false, error: 'no session' }, { status: 409 })
        const nodeId = typeof body.nodeId === 'string' ? body.nodeId : ''
        if (nodeId.length === 0) return Response.json({ ok: false, error: 'nodeId is required' }, { status: 400 })
        try {
          if (body.action === 'reparent') {
            if (typeof body.parentId !== 'string' || body.parentId.length === 0) {
              return Response.json({ ok: false, error: 'parentId is required' }, { status: 400 })
            }
            const moved = service.reparent(sessionId, nodeId, body.parentId)
            return Response.json({ ok: true, moved }, { headers: { 'cache-control': 'no-store' } })
          }
          if (body.action === 'remove') {
            // Reversible by design: the branch is hidden, not destroyed.
            const removed = service.remove(sessionId, nodeId)
            return Response.json({ ok: true, removed }, { headers: { 'cache-control': 'no-store' } })
          }
          if (body.action === 'restore') {
            const restored = service.restore(sessionId, nodeId)
            return Response.json({ ok: true, restored }, { headers: { 'cache-control': 'no-store' } })
          }
          if (body.action === 'mark') {
            const marked = service.mark(sessionId, nodeId, {
              ...(body.pinned === true || body.pinned === false ? { pinned: body.pinned } : {}),
              ...(body.ignored === true || body.ignored === false ? { ignored: body.ignored } : {}),
            })
            return Response.json({ ok: true, marked }, { headers: { 'cache-control': 'no-store' } })
          }
          return Response.json({ ok: false, error: `unknown action ${String(body.action)}` }, { status: 400 })
        } catch (error) {
          return Response.json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 409 },
          )
        }
      },
    }), 'token-tree: /api/token-tree/edit')
    ctx.logger.info(`token-tree: serving ${EDIT_ROUTE}`)

    // Settings: read the effective switches, then flip them. A patch of `null` hands
    // one switch back to whatever the profile declared.
    scoped.effect(() => connection.fetch.register({
      path: SETTINGS_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        if (request.method === 'GET') {
          return Response.json({ ok: true, ...service.settingsInfo(), effective: service.effective() }, {
            headers: { 'cache-control': 'no-store' },
          })
        }
      if (request.method !== 'POST') return Response.json({ ok: false, error: 'method not allowed' }, { status: 405 })
      let body: Record<string, unknown>
      try {
        body = await request.json() as Record<string, unknown>
      } catch {
        return Response.json({ ok: false, error: 'invalid json' }, { status: 400 })
      }
      try {
        const updated = service.updateSettings(body)
        return Response.json({ ok: true, ...updated }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        )
      }
      },
    }), 'token-tree: /api/token-tree/settings')
    ctx.logger.info(`token-tree: serving ${SETTINGS_ROUTE}`)
  }

  if (ctx.inject !== undefined) ctx.inject(['connection'], register)
  else register(ctx)
}
