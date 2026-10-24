import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as bridge from '../lib/index.js'
import { decodeMessage } from '../lib/protocol.js'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, description) {
  const deadline = Date.now() + 7000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`)
    await delay(5)
  }
}

function text() {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'done' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}
function call(name) {
  const id = ToolCallId('controlled-tool-call')
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Deterministic provider consumed by the real DSH agent loop, not emitted events. */
class ControlledProvider extends LlmAdapter {
  calls = new Map()
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(options) {
    const key = options.sessionId ?? 'unknown'
    const count = this.calls.get(key) ?? 0
    this.calls.set(key, count + 1)
    await delay(25)
    if (options.model === 'hang') {
      await new Promise((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('cancelled')); return }
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    }
    if (options.model === 'error') throw new Error('controlled provider failure')
    const chunks = count === 0 && (options.model === 'tool' || options.model === 'tool-error')
      ? call(options.model === 'tool' ? 'controlled' : 'fails') : text()
    for (const chunk of chunks) yield chunk
  }
}

async function host() {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  const provider = new ControlledProvider()
  ctx.llm.registerAdapter(['controlled'], provider)
  const approvals = new Map()
  const tools = new Map()
  ctx.on('approval/request', req => {
    const gate = deferred()
    approvals.set(req.agent.id, gate)
    return gate.promise
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'controlled', description: 'deterministic E2E tool', parameters: {},
    async execute(_args, exec) {
      assert.ok(exec.agent)
      const outcome = await ctx.approval.request({ agent: exec.agent, toolName: 'controlled', callId: exec.callId, signal: exec.signal })
      assert.equal(outcome, 'allowed-once')
      const gate = deferred()
      tools.set(exec.agent.id, gate)
      await gate.promise
      return [{ type: 'text', text: 'tool ran' }]
    },
  }))
  ctx.tools.register(defineContentToolFixture({
    name: 'fails', description: 'deterministic tool failure', parameters: {},
    async execute() { throw new Error('controlled tool failure') },
  }))
  return { ctx, provider, approvals, tools }
}
function send(agent) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'controlled E2E request' }], source: { kind: 'user' } }))
}

test('real DSH Host turns, tools, approvals, two sources, late mounting, HMR and cancellation reach the socket', { timeout: 25000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-host-'))
  const previousHome = process.env.DSH_HOME
  const previousRuntime = process.env.DSH_NATIVE_PET_RUNTIME_DIR
  process.env.DSH_HOME = join(directory, 'isolated-dsh-home')
  process.env.DSH_NATIVE_PET_RUNTIME_DIR = directory
  const snapshots = []
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const index = buffer.indexOf('\n')
        if (index < 0) break
        const message = decodeMessage(JSON.parse(buffer.slice(0, index)))
        if (message.type === 'snapshot') snapshots.push(message)
        buffer = buffer.slice(index + 1)
      }
    })
  })
  server.listen(join(directory, 'pet.sock'))
  await once(server, 'listening')
  const hosts = []
  try {
    const a = await host(); hosts.push(a)
    let pluginA = await a.ctx.plugin(bridge)
    const one = await a.ctx.agentLoop.create(SessionId('one'), { provider: 'controlled', model: 'tool' })
    const two = await a.ctx.agentLoop.create(SessionId('two'), { provider: 'controlled', model: 'tool' })
    const observed = []
    a.ctx.on('session/event', (_session, event) => { observed.push(event.type) })
    send(one); send(two)
    await until(() => snapshots.some(s => s.sessions.filter(x => x.phase === 'waiting').length === 2), 'two pending approvals')
    const originalSource = snapshots.at(-1).sourceId
    assert.ok(observed.includes('tool/call'))
    assert.ok(observed.includes('approval/asked'))
    assert.equal(a.provider.calls.get('one'), 1)
    a.approvals.get('one').resolve('allowed-once')
    await until(() => a.tools.has('one'), 'first real tool body')
    await until(() => snapshots.some(s => s.sessions.some(x => x.sessionId === 'one' && x.phase === 'working')), 'working after approval')
    a.tools.get('one').resolve()
    await one.whenIdle()
    await until(() => snapshots.some(s => s.sessions.some(x => x.sessionId === 'one' && x.phase === 'completed')
      && s.sessions.some(x => x.sessionId === 'two' && x.phase === 'waiting')), 'completed and waiting coexist')
    assert.ok(observed.includes('tool/result'))
    assert.ok(observed.includes('approval/decided'))
    assert.equal(a.provider.calls.get('one'), 2)

    // HMR while an approval is pending: registry status is enough for a truthful baseline.
    await pluginA.dispose()
    await until(() => sockets.size === 0, 'plugin unload closes socket')
    pluginA = await a.ctx.plugin(bridge)
    await until(() => snapshots.some(s => s.sourceId !== originalSource && s.sessions.some(x => x.sessionId === 'two' && x.phase === 'running')), 'late-mount running baseline')
    const replacementSource = snapshots.at(-1).sourceId
    const baseline = snapshots.find(s => s.sourceId === replacementSource)
    assert.equal(baseline.sessions.find(x => x.sessionId === 'two')?.pendingApprovals, 0)
    assert.equal(baseline.sessions.find(x => x.sessionId === 'one')?.result, null)
    a.approvals.get('two').resolve('allowed-once')
    await until(() => a.tools.has('two'), 'second tool body')
    await delay(10)
    const latestTwo = snapshots.filter(s => s.sourceId === replacementSource).at(-1).sessions.find(x => x.sessionId === 'two')
    assert.equal(latestTwo.phase, 'running')
    a.tools.get('two').resolve()
    await two.whenIdle()
    await until(() => snapshots.some(s => s.sourceId === replacementSource && s.sessions.some(x => x.sessionId === 'two' && x.phase === 'completed')), 'late turn completion')

    const b = await host(); hosts.push(b)
    await b.ctx.plugin(bridge)
    const other = await b.ctx.agentLoop.create(SessionId('one'), { provider: 'controlled', model: 'hang' })
    send(other)
    await until(() => snapshots.some(s => s.sourceId !== originalSource && s.sourceId !== replacementSource
      && s.sessions.some(x => x.sessionId === 'one' && x.phase === 'thinking')), 'second source with reused session identity')
    other.cancel({ kind: 'user' })
    await other.whenIdle()
    await until(() => snapshots.some(s => s.sessions.some(x => x.result?.outcome === 'aborted')), 'real cancellation')
    assert.equal(new Set(snapshots.map(s => s.sourceId)).size, 3)

    const toolError = await b.ctx.agentLoop.create(SessionId('tool-error'), { provider: 'controlled', model: 'tool-error' })
    send(toolError)
    await toolError.whenIdle()
    await until(() => snapshots.some(s => s.sessions.some(x => x.sessionId === 'tool-error' && x.phase === 'completed')), 'tool failure recovered by agent')
    const errorHandle = await b.ctx.agents.create({ sessionId: SessionId('provider-error'), agentOptions: { provider: 'controlled', model: 'error' } })
    const generationError = errorHandle.agent
    send(generationError)
    await generationError.whenIdle()
    await until(() => snapshots.some(s => s.sessions.some(x => x.sessionId === 'provider-error' && x.phase === 'error')), 'provider error terminal')
    await errorHandle.dispose()
    await until(() => {
      const latest = snapshots.filter(s => s.sessions.some(x => x.sessionId === 'tool-error')).at(-1)
      return latest !== undefined && !latest.sessions.some(x => x.sessionId === 'provider-error')
    }, 'real session disposal removes only that session')
    for (const h of hosts) await h.ctx.fiber.dispose()
    await until(() => sockets.size === 0, 'host teardown releases sockets')
    const count = snapshots.length
    await delay(350)
    assert.equal(snapshots.length, count, 'disposed bridges never reconnect')
    assert.ok(!JSON.stringify(snapshots).includes('controlled E2E request'), 'wire contains no conversation content')
  } finally {
    for (const h of hosts) {
      for (const gate of h.approvals.values()) gate.resolve('cancelled')
      for (const gate of h.tools.values()) gate.resolve()
      await h.ctx.fiber.dispose()
    }
    for (const socket of sockets) socket.destroy()
    server.close()
    await once(server, 'close')
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
    if (previousRuntime === undefined) delete process.env.DSH_NATIVE_PET_RUNTIME_DIR; else process.env.DSH_NATIVE_PET_RUNTIME_DIR = previousRuntime
    await rm(directory, { recursive: true, force: true })
  }
})
