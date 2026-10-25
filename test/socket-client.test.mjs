import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../lib/index.js'
import { MAX_LINE_BYTES } from '../lib/protocol.js'
import { PetSocketClient } from '../lib/socket-client.js'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, description = 'condition') {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`)
    await pause(5)
  }
}

async function receiver(t, path) {
  const messages = []
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let buffered = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffered += chunk
      for (;;) {
        const end = buffered.indexOf('\n')
        if (end < 0) break
        messages.push(JSON.parse(buffered.slice(0, end)))
        buffered = buffered.slice(end + 1)
      }
    })
  })
  try {
    server.listen(path)
    await once(server, 'listening')
  } catch (error) {
    if (error.code !== 'EPERM') throw error
    t.skip(`Unix socket listen denied by sandbox (EPERM): ${error.message}`)
    return undefined
  }
  return {
    messages, sockets,
    close: async () => {
      const closed = once(server, 'close')
      for (const socket of sockets) socket.destroy()
      server.close()
      await closed
    },
  }
}

test('initial failure, full reconnect snapshot, heartbeat, independent sources and idempotent stop', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-'))
  const path = join(directory, 'pet.sock')
  let sessions = []
  const errors = []
  const a = new PetSocketClient({ socketPath: path, sessions: () => sessions, heartbeatMs: 20, reconnectMinMs: 10, reconnectMaxMs: 20, onError: e => errors.push(e) })
  const b = new PetSocketClient({ socketPath: path, sessions: () => [], heartbeatMs: 20, reconnectMinMs: 10 })
  let host
  try {
    a.start()
    a.start()
    await until(() => errors.length > 0, 'first failure')
    await pause(80)
    assert.equal(errors.length, 1, 'repeated connection errors with the same message are deduplicated')
    sessions = [{ sessionId: 'a', turn: 1, phase: 'working', activeTools: 1, pendingApprovals: 0, result: null }]
    a.changed()
    host = await receiver(t, path)
    if (!host) return
    await until(() => host.messages.some(m => m.type === 'snapshot'), 'first snapshot')
    const baseline = host.messages[0]
    assert.equal(baseline.type, 'snapshot')
    assert.deepEqual(Object.keys(baseline).sort(), ['seq', 'sessions', 'sourceId', 'sourceLabel', 'type'])
    assert.deepEqual(baseline.sessions, sessions, 'first successful connection sends the full current state')
    assert.equal(baseline.sourceLabel, 'DSH')
    await until(() => host.messages.some(m => m.type === 'heartbeat'), 'heartbeat')
    sessions = [{ ...sessions[0], turn: 2, phase: 'thinking', activeTools: 0 }]
    a.changed()
    await until(() => host.messages.some(m => m.type === 'snapshot' && m.sessions[0]?.turn === 2), 'changed state')
    for (const socket of host.sockets) socket.destroy()
    const before = host.messages.length
    await until(() => host.messages.slice(before).some(m => m.type === 'snapshot'), 'reconnect baseline')
    const reconnected = host.messages.slice(before).find(m => m.type === 'snapshot')
    assert.deepEqual(reconnected.sessions, sessions)
    assert.equal(reconnected.sourceId, a.sourceId)
    b.start()
    await until(() => new Set(host.messages.map(m => m.sourceId)).size === 2, 'second source')
    assert.notEqual(a.sourceId, b.sourceId)
    assert.match(a.sourceId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
    assert.deepEqual(host.messages.find(m => m.sourceId === b.sourceId).sessions, [])
    const sourceMessages = host.messages.filter(m => m.sourceId === a.sourceId)
    for (let i = 1; i < sourceMessages.length; ++i) assert.ok(sourceMessages[i].seq > sourceMessages[i - 1].seq)
    a.stop(); a.stop(); b.stop(); b.stop()
    await until(() => host.sockets.size === 0, 'connection cleanup')
    const count = host.messages.length
    a.changed(); a.start()
    await pause(80)
    assert.equal(host.messages.length, count)
    assert.equal(host.sockets.size, 0)
  } finally {
    a.stop(); b.stop()
    if (host) await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('backpressure coalesces a burst to latest snapshot and releases pending work on stop', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-'))
  let host
  let client
  try {
    host = await receiver(t, join(directory, 'pet.sock'))
    if (!host) return
    let turn = 0
    client = new PetSocketClient({
      socketPath: join(directory, 'pet.sock'), sourceLabel: 's'.repeat(150000),
      sessions: () => [{ sessionId: 'burst', turn, phase: 'running', activeTools: 0, pendingApprovals: 0, result: null }],
    })
    client.start()
    await until(() => host.sockets.size === 1)
    for (const socket of host.sockets) socket.pause()
    for (turn = 1; turn <= 200; ++turn) {
      client.changed()
      await new Promise(resolve => setImmediate(resolve))
    }
    turn = 999
    client.changed()
    for (const socket of host.sockets) socket.resume()
    await until(() => host.messages.some(m => m.type === 'snapshot' && m.sessions[0]?.turn === 999), 'latest state drains')
    assert.ok(host.messages.length < 200, 'pending snapshots were coalesced')
    const lastSnapshot = host.messages.filter(m => m.type === 'snapshot').at(-1)
    assert.equal(lastSnapshot.sessions[0].turn, 999)
    client.changed()
    client.stop()
    await until(() => host.sockets.size === 0)
  } finally {
    client?.stop()
    if (host) await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('same-tick changes coalesce through the microtask into one latest snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-'))
  let host
  let client
  try {
    const path = join(directory, 'pet.sock')
    host = await receiver(t, path)
    if (!host) return
    let turn = 0
    client = new PetSocketClient({ socketPath: path, sessions: () => [{
      sessionId: 'a', turn, phase: 'thinking', activeTools: 0, pendingApprovals: 0, result: null,
    }] })
    client.start()
    await until(() => host.messages.length === 1)
    for (turn = 1; turn < 100; ++turn) client.changed()
    await until(() => host.messages.length === 2)
    assert.equal(host.messages[1].sessions[0].turn, 100)
    await pause(30)
    assert.equal(host.messages.length, 2)
  } finally {
    client?.stop()
    if (host) await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('encoding failure reports an error and destroys the connected socket', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-'))
  let host
  let client
  try {
    const path = join(directory, 'pet.sock')
    host = await receiver(t, path)
    if (!host) return
    let oversized = false
    const errors = []
    client = new PetSocketClient({
      socketPath: path, reconnectMinMs: 1000,
      sessions: () => oversized ? [{ sessionId: 'x'.repeat(MAX_LINE_BYTES) }] : [],
      onError: error => errors.push(error),
    })
    client.start()
    await until(() => host.messages.length === 1)
    oversized = true
    client.changed()
    await until(() => errors.length > 0, 'encoding error')
    assert.match(errors[0].message, /exceeds 262144 bytes/)
    await until(() => host.sockets.size === 0, 'encoding failure closes socket')
    assert.equal(host.messages.length, 1, 'invalid snapshot is never sent')
  } finally {
    client?.stop()
    if (host) await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('host observes before enumeration, refreshes delayed approval and disposes its client', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-'))
  const previous = process.env.DSH_NATIVE_PET_RUNTIME_DIR
  let host
  let dispose
  try {
    host = await receiver(t, join(directory, 'pet.sock'))
    if (!host) return
    process.env.DSH_NATIVE_PET_RUNTIME_DIR = directory
    const listeners = new Map()
    let projectionMode = 'available'
    const ctx = {
      get(name) {
        assert.equal(name, 'sessionProjections')
        if (projectionMode === 'missing') return undefined
        if (projectionMode === 'throwing') throw new Error('projection unavailable')
        return { stateOf: (session, key) => {
          assert.equal(key, 'title')
          return `${session.id} initial title`
        } }
      },
      inject(services, callback) {
        assert.deepEqual(services, ['sessions', 'agents'])
        callback(ctx)
      },
      on(name, listener) { listeners.set(name, listener) },
      agents: { get: () => ({ status: 'idle' }) },
      sessions: {
        list() {
          assert.deepEqual([...listeners.keys()], ['session/created', 'session/disposed', 'session/event', 'agent/status'])
          listeners.get('session/event')({ id: 'a' }, { type: 'turn/start', seq: 0, data: { turn: 1 } })
          listeners.get('session/event')({ id: 'a' }, { type: 'session/title', seq: 1, data: { title: 'live title' } })
          return [{ id: 'a' }, { id: 'baseline' }]
        },
      },
      fiber: { effect(callback) { dispose = callback() } },
      logger: { warn(message) { assert.fail(message) } },
    }
    apply(ctx)
    await until(() => host.messages.some(m => m.type === 'snapshot'), 'host baseline')
    assert.equal(host.messages[0].sessions[0].phase, 'thinking', 'enumeration preserves observed turn')
    assert.equal(host.messages[0].sessions[0].title, 'live title', 'enumeration preserves observed title')
    assert.equal(host.messages[0].sessions[1].title, 'baseline initial title')
    assert.equal(host.messages[0].sessions[1].phase, 'idle')
    assert.equal(host.messages[0].sessions[1].result, null, 'baseline does not replay historical results')
    listeners.get('session/created')({ id: 'new' })
    listeners.get('agent/status')({ agent: { id: 'new' }, status: 'running' })
    listeners.get('session/disposed')({ id: 'baseline' })
    listeners.get('session/event')({ id: 'a' }, { type: 'approval/asked', seq: 2, data: { id: 'ask' } })
    await until(() => host.messages.some(m => m.type === 'snapshot' && m.sessions[0]?.pendingApprovals === 1), 'approval observed')
    const immediate = host.messages.find(m => m.type === 'snapshot' && m.sessions[0]?.pendingApprovals === 1)
    assert.equal(immediate.sessions[0].phase, 'thinking')
    assert.deepEqual(immediate.sessions.map(s => [s.sessionId, s.phase]), [['a', 'thinking'], ['new', 'running']])
    assert.equal(immediate.sessions[1].title, 'new initial title')
    await until(() => host.messages.some(m => m.type === 'snapshot' && m.sessions[0]?.phase === 'waiting'), 'approval timer refresh')
    projectionMode = 'missing'
    listeners.get('session/created')({ id: 'no-service' })
    projectionMode = 'throwing'
    listeners.get('session/created')({ id: 'failed-projection' })
    await until(() => host.messages.some(m => m.sessions?.length === 4), 'optional projection unavailable')
    assert.deepEqual(host.messages.at(-1).sessions.slice(2).map(s => s.title), [null, null])
    dispose()
    await until(() => host.sockets.size === 0, 'host disposal')
    const count = host.messages.length
    listeners.get('agent/status')({ agent: { id: 'a' }, status: 'running' })
    await pause(30)
    assert.equal(host.messages.length, count)
  } finally {
    dispose?.()
    if (previous === undefined) delete process.env.DSH_NATIVE_PET_RUNTIME_DIR
    else process.env.DSH_NATIVE_PET_RUNTIME_DIR = previous
    if (host) await host.close()
    await rm(directory, { recursive: true, force: true })
  }
})
