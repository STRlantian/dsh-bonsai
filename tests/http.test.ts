import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config } from '../src/plugin/config.ts'
import { EDIT_ROUTE, FOCUS_ROUTE, SETTINGS_ROUTE, TREE_ROUTE, installHttpRoute } from '../src/plugin/http.ts'
import { SettingsStore } from '../src/plugin/settings.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import type { ConnectionFetchRouteLike, ContextLike } from '../src/plugin/dsh.ts'

/** Quiet logger. */
const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

/** Mount both routes against a fake host and hand back the read handler. */
function mountRoute(): { service: TokenTreeService; handle: (url: string, method?: string) => Promise<Response> } {
  const mounted = mountHost()
  return {
    service: mounted.service,
    handle: async (url, method = 'GET') => mounted.routes.get(TREE_ROUTE)!.fetch(new Request(url, { method })),
  }
}

/** Mount both routes and expose the write handler too. */
function mountHost(settings?: SettingsStore): {
  service: TokenTreeService
  routes: Map<string, ConnectionFetchRouteLike>
} {
  const config = Config['~standard'].validate({ logEdgeUpdates: false })
  assert.ok(config.value !== undefined)
  const service = new TokenTreeService({ config: config.value, logger, ...(settings === undefined ? {} : { settings }) })
  const routes = new Map<string, ConnectionFetchRouteLike>()
  const scoped = {
    logger,
    connection: {
      fetch: {
        register(candidate: ConnectionFetchRouteLike) {
          routes.set(candidate.path, candidate)
          return async () => {}
        },
      },
    },
    effect: (execute: () => unknown) => { execute(); return () => {} },
  } as unknown as ContextLike
  const ctx = {
    logger,
    inject: (_services: readonly string[], callback: (inner: ContextLike) => void) => { callback(scoped); return undefined },
  } as unknown as ContextLike

  installHttpRoute(ctx, service)
  assert.ok(routes.has(TREE_ROUTE), 'tree route registered')
  assert.ok(routes.has(FOCUS_ROUTE), 'focus route registered')
  return { service, routes }
}

/** Seed one exchange into a session. */
function seed(service: TokenTreeService, sessionId: string): void {
  let seq = 0
  const event = (type: string, data: Record<string, unknown>): void => {
    service.handleEvent({ id: sessionId }, { type, seq: ++seq, time: seq * 1_000, data })
  }
  event('user/message', {
    id: 'm1',
    role: 'user',
    content: [{ type: 'text', text: '什么是注意力机制？' }],
    source: { kind: 'user' },
  })
  event('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '按相关性加权求和。' }] },
  })
}

test('a missing session parameter falls back to the newest session', async () => {
  const { service, handle } = mountRoute()
  seed(service, 'session-a')

  const response = await handle('http://host/api/token-tree/tree')
  assert.equal(response.status, 200)
  const payload = await response.json() as { sessionId: string; blocks: unknown[]; requested?: string }
  assert.equal(payload.sessionId, 'session-a')
  assert.equal(payload.blocks.length, 1)
  assert.equal(payload.requested, undefined)
})

test('a named session is answered as asked', async () => {
  const { service, handle } = mountRoute()
  seed(service, 'session-a')

  const response = await handle('http://host/api/token-tree/tree?session=session-a')
  assert.equal(response.status, 200)
  const payload = await response.json() as { sessionId: string; requested?: string; blocks: unknown[] }
  assert.equal(payload.sessionId, 'session-a')
  assert.equal(payload.requested, 'session-a')
  assert.equal(payload.blocks.length, 1)
})

test('an empty parameter is treated as unbound, not as a client error', async () => {
  const { service, handle } = mountRoute()
  seed(service, 'session-a')

  const response = await handle('http://host/api/token-tree/tree?session=')
  assert.equal(response.status, 200)
  const payload = await response.json() as { sessionId: string }
  assert.equal(payload.sessionId, 'session-a')
})

test('with nothing observed yet the route answers an empty payload', async () => {
  const { handle } = mountRoute()
  const response = await handle('http://host/api/token-tree/tree')
  assert.equal(response.status, 200)
  const payload = await response.json() as { sessionId: string; blocks: unknown[] }
  assert.equal(payload.sessionId, '')
  assert.deepEqual(payload.blocks, [])
})

test('HEAD answers without a body', async () => {
  const { service, handle } = mountRoute()
  seed(service, 'session-a')
  const response = await handle('http://host/api/token-tree/tree?session=session-a', 'HEAD')
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '')
})

test('the plugin never registers on the shared rpc channel', async () => {
  // `/api` carries a single interceptor slot and the Typert gateway owns it. A
  // plugin that registers there replaces the gateway, and every other RPC answers
  // 404 - so this plugin must only ever add an exact fetch route.
  const config = Config['~standard'].validate({ logEdgeUpdates: false })
  assert.ok(config.value !== undefined)
  const service = new TokenTreeService({ config: config.value, logger })
  let intercepted = 0
  const scoped = {
    logger,
    connection: {
      fetch: { register: () => async () => {} },
      rpc: { intercept: () => { intercepted++; return async () => {} } },
    },
    effect: (execute: () => unknown) => { execute(); return () => {} },
  } as unknown as ContextLike
  const ctx = {
    logger,
    inject: (_services: readonly string[], callback: (inner: ContextLike) => void) => { callback(scoped); return undefined },
  } as unknown as ContextLike

  installHttpRoute(ctx, service)
  assert.equal(intercepted, 0)
})

/** Call one write route with a JSON body. */
async function post(
  routes: Map<string, ConnectionFetchRouteLike>,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request(`http://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await routes.get(path)!.fetch(request)
  return { status: response.status, json: await response.json() as Record<string, unknown> }
}

test('the focus route anchors and clears through http', async () => {
  const { service, routes } = mountHost()
  seed(service, 'session-a')
  const question = [...service.treeOf('session-a').nodes.values()].find(node => node.kind === 'question')
  assert.ok(question !== undefined)

  const anchored = await post(routes, FOCUS_ROUTE, { session: 'session-a', nodeId: question.id })
  assert.equal(anchored.status, 200)
  assert.equal(anchored.json.ok, true)
  assert.equal(service.anchoredNode('session-a'), question.id)

  const cleared = await post(routes, FOCUS_ROUTE, { session: 'session-a', clear: true })
  assert.equal(cleared.status, 200)
  assert.equal(service.anchoredNode('session-a'), undefined)
})

test('the edit route reparents and deletes', async () => {
  const { service, routes } = mountHost()
  seed(service, 'session-a')
  const tree = service.treeOf('session-a')
  const question = [...tree.nodes.values()].find(node => node.kind === 'question')
  const answer = [...tree.nodes.values()].find(node => node.kind === 'answer')
  assert.ok(question !== undefined && answer !== undefined)

  const moved = await post(routes, EDIT_ROUTE, {
    session: 'session-a',
    action: 'reparent',
    nodeId: answer.id,
    parentId: tree.rootId,
  })
  assert.equal(moved.status, 200)
  assert.equal(tree.node(answer.id).parentId, tree.rootId)

  const removed = await post(routes, EDIT_ROUTE, { session: 'session-a', action: 'remove', nodeId: question.id })
  assert.equal(removed.status, 200)
  // Delete is a mark now: the node stays and can be restored.
  assert.equal(tree.nodes.has(question.id), true)
  assert.equal(tree.hidden(question.id), true)

  const restored = await post(routes, EDIT_ROUTE, { session: 'session-a', action: 'restore', nodeId: question.id })
  assert.equal(restored.status, 200)
  assert.equal(tree.hidden(question.id), false)

  // A cycle is refused with 409, not a crash.
  const asked = await post(routes, EDIT_ROUTE, { session: 'session-a', action: 'reparent', nodeId: answer.id, parentId: answer.id })
  assert.equal(asked.status, 409)
})

test('the edit route marks a node', async () => {
  const { service, routes } = mountHost()
  seed(service, 'session-a')
  const question = [...service.treeOf('session-a').nodes.values()].find(node => node.kind === 'question')
  assert.ok(question !== undefined)

  const marked = await post(routes, EDIT_ROUTE, { session: 'session-a', action: 'mark', nodeId: question.id, pinned: true })
  assert.equal(marked.status, 200)
  assert.equal(service.treeOf('session-a').node(question.id).metadata.pinned, true)
})

test('the settings route reads, writes and clears a switch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tt-settings-route-'))
  const path = join(dir, 'settings.json')
  try {
    const settings = new SettingsStore({ path, onError: () => {} })
    const { service, routes } = mountHost(settings)

    const read = await routes.get(SETTINGS_ROUTE)!.fetch(new Request(`http://host${SETTINGS_ROUTE}`, { method: 'GET' }))
    const before = await read.json() as { ok: boolean; effective: { autoInject: boolean; hintMinNodes: number }; overrides: object }
    assert.equal(before.ok, true)
    assert.equal(before.effective.autoInject, false, 'profile default')
    assert.deepEqual(before.overrides, {})

    const wrote = await post(routes, SETTINGS_ROUTE, { autoInject: true, hintMinNodes: 12 })
    assert.equal(wrote.status, 200)
    assert.deepEqual(settings.all(), { autoInject: true, hintMinNodes: 12 })
    assert.equal(service.effective().autoInject, true, 'the override is effective immediately')
    assert.equal(service.effective().hintMinNodes, 12)

    // null hands the key back to the profile config.
    const cleared = await post(routes, SETTINGS_ROUTE, { autoInject: null })
    assert.equal(cleared.status, 200)
    assert.equal(service.effective().autoInject, false)
    assert.deepEqual(settings.all(), { hintMinNodes: 12 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
