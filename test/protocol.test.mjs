import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { decodeMessage, encodeMessage, MAX_LINE_BYTES, socketPath } from '../lib/protocol.js'

const session = (overrides = {}) => ({
  sessionId: 'session-a', title: null, turn: 1, phase: 'thinking', activeTools: 0, pendingApprovals: 0, result: null,
  ...overrides,
})
const snapshot = (overrides = {}) => ({
  type: 'snapshot', sourceId: 'source-a', sourceLabel: 'DSH', seq: 1, sessions: [session()], ...overrides,
})
const heartbeat = () => ({ type: 'heartbeat', sourceId: 'source-a', seq: 20 })
const activity = () => ({
  type: 'activity', provider: 'codex', sessionId: 'hook-session', turnId: 'turn-a',
  label: null, eventId: 'event-a', kind: 'turnStarted', occurredAt: 1792756800, toolId: null,
})

test('snapshot, heartbeat and upstream activity round-trip with exact wire fields', () => {
  const messages = [snapshot({ sessions: [] }), heartbeat(), activity(), {
    ...activity(), provider: 'claudeCode', turnId: null, kind: 'sessionEnded',
  }]
  for (const phase of ['idle', 'running', 'thinking', 'working', 'waiting', 'completed', 'error', 'stopped']) {
    messages.push(snapshot({ sessions: [session({ phase, turn: phase === 'idle' ? null : 1 })] }))
  }
  for (const outcome of ['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'other']) {
    messages.push(snapshot({ sessions: [session({ result: { id: 'result-a', outcome } })] }))
  }
  for (const message of messages) {
    const encoded = encodeMessage(decodeMessage(message))
    assert.equal(encoded.at(-1), '\n')
    assert.equal(encoded.split('\n').length, 2)
    assert.deepEqual(decodeMessage(JSON.parse(encoded)), message)
    assert.equal(Object.hasOwn(JSON.parse(encoded), 'v'), false)
  }
})

test('unknown fields are stripped at every depth, matching the upstream decoder', () => {
  const expected = snapshot({ sessions: [session({ result: { id: 'r', outcome: 'completed' } })] })
  const input = snapshot({ secret: 'private', sessions: [session({
    prompt: 'private', result: { id: 'r', outcome: 'completed', optional: 'ignored' },
  })] })
  assert.deepEqual(decodeMessage(input), expected)
  assert.equal(encodeMessage(decodeMessage(input)).includes('private'), false)
  assert.deepEqual(decodeMessage({ ...heartbeat(), sessions: 'ignored', sourceLabel: false }), heartbeat())
  assert.deepEqual(decodeMessage({ ...activity(), optional: 'ignored' }), activity())
})

test('optional title and label round-trip, reject wrong types and retain unknown-field stripping', () => {
  for (const title of [null, '会话标题', '😀'.repeat(256)]) {
    const expected = snapshot({ sessions: [session({ title })] })
    assert.deepEqual(decodeMessage({ ...expected, ignored: true }), expected)
  }
  for (const label of [null, 'harness-native-pet']) {
    const expected = { ...activity(), label }
    assert.deepEqual(decodeMessage({ ...expected, ignored: true }), expected)
  }
  for (const value of [false, 123, {}, []]) {
    assert.throws(() => decodeMessage(snapshot({ sessions: [session({ title: value })] })), /session snapshot/)
    assert.throws(() => decodeMessage({ ...activity(), label: value }), /activity/)
  }
})

test('rejects duplicate sessionId inside one snapshot', () => {
  assert.throws(() => decodeMessage(snapshot({ sessions: [session(), session({ turn: 2 })] })), /session snapshot/)
  assert.doesNotThrow(() => decodeMessage(snapshot({ sessions: [session(), session({ sessionId: 'other' })] })))
})

test('rejects missing or wrongly typed required fields including nullable fields', () => {
  for (const make of [snapshot, heartbeat, activity]) {
    for (const key of Object.keys(make()).filter(key => key !== 'label')) {
      const missing = make()
      delete missing[key]
      assert.throws(() => decodeMessage(missing), Error, `${make().type}: missing ${key}`)
      assert.throws(() => decodeMessage({ ...make(), [key]: false }), Error, `${make().type}: wrong ${key}`)
    }
  }
  for (const key of Object.keys(session()).filter(key => key !== 'title')) {
    const missing = session()
    delete missing[key]
    assert.throws(() => decodeMessage(snapshot({ sessions: [missing] })), /session snapshot/)
    assert.throws(() => decodeMessage(snapshot({ sessions: [session({ [key]: false })] })), /session snapshot/)
  }
  for (const result of [{ id: 'r' }, { outcome: 'completed' }, { id: '', outcome: 'completed' }, []]) {
    assert.throws(() => decodeMessage(snapshot({ sessions: [session({ result })] })), /session snapshot/)
  }
  for (const value of [null, false, [], {}, { type: 'unknown' }]) assert.throws(() => decodeMessage(value))
  for (const sourceId of ['', false, 'hook:codex', 'hook:']) {
    assert.throws(() => decodeMessage(snapshot({ sourceId })), /source or sequence/)
    assert.throws(() => decodeMessage({ ...heartbeat(), sourceId }), /source or sequence/)
  }
  assert.throws(() => decodeMessage(snapshot({ sourceLabel: '' })), /session snapshot/)
})

test('sequence and session counts require safe non-negative integers, sequence starts at one', () => {
  const invalidNaturals = [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]
  for (const seq of [0, ...invalidNaturals]) {
    assert.throws(() => decodeMessage(snapshot({ seq })), /source or sequence/)
    assert.throws(() => decodeMessage({ ...heartbeat(), seq }), /source or sequence/)
  }
  for (const key of ['turn', 'activeTools', 'pendingApprovals']) {
    for (const value of invalidNaturals.filter(value => key !== 'turn' || value !== null)) {
      assert.throws(() => decodeMessage(snapshot({ sessions: [session({ [key]: value })] })), /session snapshot/)
    }
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      assert.doesNotThrow(() => decodeMessage(snapshot({ sessions: [session({ [key]: value })] })))
    }
  }
  assert.doesNotThrow(() => decodeMessage(snapshot({ seq: Number.MAX_SAFE_INTEGER })))
})

test('rejects unknown phase, outcome and invalid upstream activity values', () => {
  assert.throws(() => decodeMessage(snapshot({ sessions: [session({ phase: 'approved' })] })), /session snapshot/)
  assert.throws(() => decodeMessage(snapshot({ sessions: [session({ result: { id: 'r', outcome: 'success' } })] })), /session snapshot/)
  for (const fields of [
    { provider: 'other' }, { kind: 'other' }, { sessionId: '' }, { eventId: '' }, { turnId: '' }, { toolId: '' },
    { occurredAt: -1 }, { occurredAt: Infinity }, { occurredAt: NaN },
  ]) assert.throws(() => decodeMessage({ ...activity(), ...fields }), /activity/)
})

test('v accepts absence or numeric one and rejects every other value clearly', () => {
  for (const make of [snapshot, heartbeat, activity]) {
    assert.deepEqual(decodeMessage(make()), make())
    assert.deepEqual(decodeMessage({ ...make(), v: 1 }), make())
    for (const v of [undefined, null, 0, 2, '1', true, 1.5]) {
      assert.throws(() => decodeMessage({ ...make(), v }), /Unsupported desktop pet protocol version/)
    }
  }
})

test('encoded size uses UTF-8 bytes, allows exactly the limit and rejects oversized lines', () => {
  assert.equal(MAX_LINE_BYTES, 262144)
  const message = snapshot({ sourceLabel: '', sessions: [] })
  const overhead = Buffer.byteLength(JSON.stringify(message))
  message.sourceLabel = 'x'.repeat(MAX_LINE_BYTES - overhead)
  assert.equal(Buffer.byteLength(encodeMessage(message)), MAX_LINE_BYTES + 1, 'limit excludes NDJSON newline')
  message.sourceLabel += 'x'
  assert.throws(() => encodeMessage(message), /exceeds 262144 bytes/)
  message.sourceLabel = '中'.repeat(MAX_LINE_BYTES / 2)
  assert.throws(() => encodeMessage(message), /exceeds/)
  message.sourceLabel = 'DSH'
  assert.doesNotThrow(() => encodeMessage(message))
})

test('socketPath honors explicit directory, runtime environment and home default', t => {
  const previous = process.env.DSH_NATIVE_PET_RUNTIME_DIR
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_NATIVE_PET_RUNTIME_DIR
    else process.env.DSH_NATIVE_PET_RUNTIME_DIR = previous
  })
  delete process.env.DSH_NATIVE_PET_RUNTIME_DIR
  assert.equal(socketPath(), join(homedir(), 'Library/Application Support/dsh-native-pet', 'pet.sock'))
  process.env.DSH_NATIVE_PET_RUNTIME_DIR = '/tmp/dsh-pet-env'
  assert.equal(socketPath(), '/tmp/dsh-pet-env/pet.sock')
  assert.equal(socketPath('/tmp/dsh-pet-explicit'), '/tmp/dsh-pet-explicit/pet.sock')
})

test('title and label normalize missing, empty, controls and scalar boundaries', () => {
  const cases = [[undefined, null], ['', null], [' \t\u200b ', null],
    [' \0会\n话\u007f\u0085\u200b\u202e标题\ufeff ', '会话标题'],
    ['\u00a0\u2000\u2028标题\u2029\u3000', '标题']]
  for (const char of ['a', '中', '😀']) {
    for (const count of [64, 65, 256, 257, 1024]) cases.push([char.repeat(count), char.repeat(Math.min(count, 256))])
  }
  cases.push(['e\u0301'.repeat(129), 'e\u0301'.repeat(128)])
  cases.push(['中'.repeat(255) + '😀尾', '中'.repeat(255) + '😀'])
  for (const [input, expected] of cases) {
    const item = session()
    const event = activity()
    if (input === undefined) { delete item.title; delete event.label }
    else { item.title = input; event.label = input }
    assert.equal(decodeMessage(snapshot({ sessions: [item] })).sessions[0].title, expected)
    assert.equal(decodeMessage(event).label, expected)
  }
})
