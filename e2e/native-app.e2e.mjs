import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, description, timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`)
    await delay(10)
  }
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

/** The normal Host executes this stream and registered tool; no event/socket injection. */
class NativeE2EProvider extends LlmAdapter {
  calls = 0
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async *stream(_options) {
    this.calls += 1
    if (this.calls === 1) {
      const id = ToolCallId('native-e2e-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'native_e2e_tool', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'native_e2e_tool', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'finished' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'finished' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

function launch(binary, capture, runtimeDirectory, switching) {
  // Capture before the three-second completion feedback expires.
  const args = switching ? ['--capture-skin-switch', resolve(capture, '..')] : ['--capture-live', capture, '--capture-after', '2']
  const child = spawn(binary, [...args, '-pet.skin', 'character', '-pet.animations', 'YES', '-pet.visible', 'YES', '-pet.size', 'medium', '-pet.noticeMinimumSeconds', '0'], {
    env: { ...process.env, DSH_NATIVE_PET_RUNTIME_DIR: runtimeDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  let exited = false
  const exit = new Promise((done, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { exited = true; done({ code, signal }) })
  })
  return { child, stdout: () => stdout, stderr: () => stderr, exited: () => exited, exit }
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const done = new Promise(resolve => child.once('close', () => resolve()))
  child.kill('SIGTERM')
  const force = setTimeout(() => child.kill('SIGKILL'), 2000)
  try { await done } finally { clearTimeout(force) }
}

for (const expected of ['waiting', 'completed', 'skin-switch']) {
  test(`real DSH Host → bridge → native PetStore → live UI captures ${expected}`, { timeout: 20000 }, async () => {
    assert.equal(process.platform, 'darwin', 'native UI E2E requires macOS')
    assert.ok(process.env.DSH_NATIVE_PET_APP, 'Set DSH_NATIVE_PET_APP to an already-built DSHNativePet binary; this test never builds Swift')
    const binary = resolve(process.env.DSH_NATIVE_PET_APP)
    await access(binary)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-pet-native-'))
    const captureDirectory = process.env.DSH_NATIVE_PET_CAPTURE_DIR ? resolve(process.env.DSH_NATIVE_PET_CAPTURE_DIR) : await mkdtemp(join(tmpdir(), 'dsh-pet-native-captures-'))
    await mkdir(captureDirectory, { recursive: true })
    const capture = join(captureDirectory, `${expected}.png`)
    const evidence = join(captureDirectory, `${expected}.json`)
    const previousHome = process.env.DSH_HOME
    const previousRuntime = process.env.DSH_NATIVE_PET_RUNTIME_DIR
    process.env.DSH_HOME = join(directory, 'dsh-home')
    process.env.DSH_NATIVE_PET_RUNTIME_DIR = directory
    const ctx = new Context()
    const approval = deferred()
    const tool = deferred()
    let asked = false
    let toolFinished = false
    const events = []
    let app
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjections)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(ApprovalService, { policy: 'ask' })
      const provider = new NativeE2EProvider()
      ctx.llm.registerAdapter(['native-e2e'], provider)
      ctx.on('session/event', (_session, event) => { events.push(event.type) })
      ctx.on('approval/request', () => { asked = true; return approval.promise })
      ctx.tools.register(defineContentToolFixture({
        name: 'native_e2e_tool', description: 'Native UI integration fixture', parameters: {},
        async execute(_args, execution) {
          assert.ok(execution.agent)
          const outcome = await ctx.approval.request({ agent: execution.agent, toolName: 'native_e2e_tool', callId: execution.callId, signal: execution.signal })
          if (outcome === 'allowed-once') {
            await tool.promise
            toolFinished = true
          }
          return [{ type: 'text', text: outcome }]
        },
      }))
      const handle = await ctx.agents.create({ sessionId: SessionId(`native-${expected}`), agentOptions: { provider: 'native-e2e', model: 'deterministic' } })
      app = launch(binary, capture, directory, expected === 'skin-switch')
      await until(async () => {
        if (app.exited()) throw new Error(`App exited before socket was ready: ${app.stdout()} ${app.stderr()}`)
        try { return (await stat(join(directory, 'pet.sock'))).isSocket() } catch { return false }
      }, 'native listener socket')
      await ctx.plugin(bridge)
      // Capture-only UI instrumentation confirms its first source snapshot entered PetStore.
      await until(() => {
        if (app.exited()) throw new Error(`App exited before idle baseline: ${app.stdout()} ${app.stderr()}`)
        return /DSHNativePet live update: pose=idle\b/.test(app.stdout())
      }, 'native idle baseline before starting the real turn')
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'native UI E2E fixture' }], source: { kind: 'user' } }))
      await until(() => asked, 'real Host approval request')
      assert.ok(events.includes('turn/start'))
      assert.ok(events.includes('tool/call'))
      assert.ok(events.includes('approval/asked'))
      if (expected === 'completed') {
        approval.resolve('allowed-once')
        tool.resolve()
        await handle.agent.whenIdle()
        assert.ok(toolFinished)
        assert.equal(provider.calls, 2)
        assert.ok(events.includes('approval/decided'))
        assert.ok(events.includes('tool/result'))
        assert.ok(events.includes('turn/end'))
      } else if (expected === 'skin-switch') {
        approval.resolve('allowed-once')
        await until(() => /live update: pose=working\b/.test(app.stdout()), 'native working state before skin changes')
        assert.equal(provider.calls, 1)
      } else {
        assert.equal(provider.calls, 1)
      }
      const exit = await app.exit
      assert.equal(exit.code, 0, `${app.stdout()}\n${app.stderr()}`)
      assert.equal(exit.signal, null)
      if (expected === 'skin-switch') {
        const states = await Promise.all(['1-character', '2-dshPet', '3-character'].map(async name => {
          const value = JSON.parse(await readFile(join(captureDirectory, `${name}.json`), 'utf8'))
          const png = await readFile(join(captureDirectory, `${name}.png`))
          assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
          assert.equal(value.pose, 'working')
          assert.equal(value.storePose, 'working')
          assert.equal(value.connectedSources, 1)
          assert.deepEqual(value.sessionIDs, ['native-skin-switch'])
          assert.equal(value.characterHeight, 100)
          return value
        }))
        assert.deepEqual(states.map(s => s.skin), ['character', 'dshPet', 'character'])
        assert.deepEqual(states.map(s => s.playerActive), [false, true, false])
        assert.equal(new Set(states.map(s => s.processID)).size, 1)
        assert.ok(states.every(s => Number.isFinite(s.footScreenX) && Number.isFinite(s.footScreenY)))
        assert.ok(states.every(s => Math.abs(s.footScreenX - states[0].footScreenX) < 0.01
          && Math.abs(s.footScreenY - states[0].footScreenY) < 0.01))
        assert.equal(states[0].sizePreference, states[1].sizePreference)
        assert.equal(states[1].sizePreference, states[2].sizePreference)
        assert.equal(states[0].frame, states[2].frame)
        const video = states[1]
        assert.equal(video.source, 'AVPlayerItemVideoOutput')
        assert.equal(video.playerReady, true)
        assert.ok(video.videoTime > 0 && video.decodedTransparentPixels > 0 && video.decodedOpaquePixels > 0)
        await writeFile(evidence, JSON.stringify({ scenario: expected, passed: true, binary,
          hostEvents: events, states, stdout: app.stdout(), stderr: app.stderr() }, null, 2) + '\n')
        console.log(`Native skin-switch E2E evidence: ${evidence}`)
        return
      }
      assert.match(app.stdout(), new RegExp(`Preview captured from live PetPanel: .*; state=${expected}\\b`))
      const png = await readFile(capture)
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.ok(png.length > 1000, 'native UI produced a nonempty PNG')
      assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0)
      await writeFile(evidence, JSON.stringify({
        scenario: expected, passed: true, binary, capture, width: png.readUInt32BE(16), height: png.readUInt32BE(20),
        sha256: createHash('sha256').update(png).digest('hex'), providerCalls: provider.calls,
        hostEvents: events, stdout: app.stdout(), stderr: app.stderr(),
      }, null, 2) + '\n')
      console.log(`Native E2E evidence: ${evidence}`)
    } catch (error) {
      await writeFile(evidence, JSON.stringify({ scenario: expected, passed: false, binary, capture,
        error: String(error), hostEvents: events, stdout: app?.stdout(), stderr: app?.stderr() }, null, 2) + '\n')
      throw error
    } finally {
      approval.resolve('cancelled')
      tool.resolve()
      if (app) await terminate(app.child)
      await ctx.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome
      if (previousRuntime === undefined) delete process.env.DSH_NATIVE_PET_RUNTIME_DIR; else process.env.DSH_NATIVE_PET_RUNTIME_DIR = previousRuntime
      // Captures remain reviewable; temporary runtime and DSH_HOME always disappear.
      await rm(directory, { recursive: true, force: true })
    }
  })
}
