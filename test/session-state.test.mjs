import assert from 'node:assert/strict'
import { test } from 'node:test'
import { APPROVAL_DELAY_MS, SessionStates } from '../lib/session-state.js'

function event(type, seq, data) {
  return { type, seq, data, time: 1 }
}
const start = (seq = 0, turn = 1) => event('turn/start', seq, { turn })
const call = (seq, callId) => event('tool/call', seq, { turn: 1, step: 1, callId, name: 'test', arguments: '{}' })
const result = (seq, callId) => event('tool/result', seq, { turn: 1, step: 1, message: { toolCallId: callId, isError: true } })
const end = (seq, kind = 'completed') => event('turn/end', seq, { turn: 1, reason: { kind } })

test('parallel calls pair by nested result ID; tool failure does not end the turn', () => {
  const states = new SessionStates()
  states.event('a', start())
  states.event('a', call(1, 'one'))
  states.event('a', call(2, 'two'))
  states.event('a', result(3, 'one'))
  assert.equal(states.snapshot()[0]?.activeTools, 1)
  assert.equal(states.snapshot()[0]?.phase, 'working')
  states.event('a', result(4, 'two'))
  assert.equal(states.snapshot()[0]?.phase, 'thinking')
})

test('late attach keeps unknown running after unmatched results and decisions', () => {
  const states = new SessionStates()
  states.initialize('a', 'running')
  states.event('a', result(40, 'unseen-call'))
  states.event('a', event('approval/decided', 41, { id: 'unseen-ask', outcome: 'allowed-once' }))
  states.initialize('a', 'idle')
  assert.equal(states.snapshot()[0]?.phase, 'running')
  states.status('a', 'idle')
  assert.equal(states.snapshot()[0]?.phase, 'idle')
  states.event('a', start(42, 2))
  assert.equal(states.snapshot()[0]?.phase, 'thinking')
})

test('approval debounce and independent IDs preserve all pending requests', () => {
  const states = new SessionStates()
  states.event('a', start())
  states.event('a', call(1, 'one'))
  states.event('a', event('approval/asked', 2, { id: 'ask-one', toolName: 'test', callId: 'one' }), 100)
  states.event('a', event('approval/asked', 3, { id: 'ask-two', toolName: 'test' }), 110)
  assert.equal(states.snapshot(100)[0]?.phase, 'working')
  assert.equal(states.nextApprovalDeadline(100), 100 + APPROVAL_DELAY_MS)
  states.event('a', event('approval/decided', 4, { id: 'ask-one', outcome: 'allowed-once' }), 120)
  assert.equal(states.snapshot(110 + APPROVAL_DELAY_MS)[0]?.phase, 'waiting')
  assert.equal(states.snapshot(110 + APPROVAL_DELAY_MS)[0]?.pendingApprovals, 1)
  states.event('a', event('approval/decided', 5, { id: 'ask-two', outcome: 'rejected' }), 500)
  assert.equal(states.snapshot(500)[0]?.phase, 'working')
})

test('instant approvals do not display waiting; unknown running survives observed approval', () => {
  const states = new SessionStates()
  states.initialize('a', 'running')
  states.event('a', event('approval/asked', 1, { id: 'ask', toolName: 'test' }), 100)
  states.event('a', event('approval/decided', 2, { id: 'ask', outcome: 'allowed-once' }), 110)
  assert.equal(states.snapshot(500)[0]?.phase, 'running')
  assert.equal(states.nextApprovalDeadline(110), undefined)
})

for (const kind of ['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'custom/end']) {
  test(`terminal ${kind} clears activity, survives idle, and isolates other sessions`, () => {
    const states = new SessionStates()
    states.event('a', start())
    states.event('a', call(1, 'one'))
    states.event('a', event('approval/asked', 2, { id: 'ask', toolName: 'test' }))
    states.initialize('b', 'running')
    states.event('a', end(3, kind))
    states.status('a', 'idle')
    const a = states.snapshot()[0]
    assert.equal(a.activeTools, 0)
    assert.equal(a.pendingApprovals, 0)
    assert.equal(a.phase, kind === 'completed' ? 'completed' : kind === 'error' ? 'error' : 'stopped')
    assert.equal(a.result?.outcome, kind === 'custom/end' ? 'other' : kind)
    assert.equal(states.snapshot()[1]?.phase, 'running')
    states.event('a', call(2, 'stale'))
    assert.deepEqual(states.snapshot()[0], a)
    states.remove('a')
    assert.deepEqual(states.snapshot().map(s => s.sessionId), ['b'])
  })
}

test('next running and turn reset terminal feedback', () => {
  const states = new SessionStates()
  states.event('a', start())
  states.event('a', end(1))
  states.status('a', 'running')
  assert.equal(states.snapshot()[0]?.phase, 'running')
  assert.equal(states.snapshot()[0]?.result, null)
  states.event('a', start(2, 2))
  assert.equal(states.snapshot()[0]?.turn, 2)
  assert.equal(states.snapshot()[0]?.phase, 'thinking')
})

test('terminal survives non-terminal events followed by late tools and approvals', () => {
  const states = new SessionStates()
  states.event('a', start())
  states.event('a', end(1))
  const terminal = states.snapshot()[0]
  states.event('a', event('assistant/message', 2, { message: 'ignored' }))
  states.event('a', call(3, 'late'))
  states.event('a', result(4, 'late'))
  states.event('a', event('approval/asked', 5, { id: 'late' }), 100)
  assert.deepEqual(states.snapshot(1000)[0], terminal)
  assert.equal(states.nextApprovalDeadline(100), undefined)
})

test('sequence ordering deduplicates events per session, including unknown events', () => {
  const states = new SessionStates()
  states.event('a', start(10))
  states.event('a', call(11, 'one'))
  states.event('a', call(11, 'duplicate-seq'))
  states.event('a', end(9))
  states.event('a', start(10, 2))
  assert.equal(states.snapshot()[0].turn, 1)
  assert.equal(states.snapshot()[0].activeTools, 1)
  states.event('a', call(12, 'one'))
  assert.equal(states.snapshot()[0].activeTools, 1, 'tools pair by callId')
  states.event('a', event('assistant/message', 20, {}))
  states.event('a', result(19, 'one'))
  assert.equal(states.snapshot()[0].activeTools, 1)
  states.event('b', start(0))
  assert.equal(states.snapshot()[1].phase, 'thinking')
  states.event('a', result(21, 'one'))
  assert.equal(states.snapshot()[0].phase, 'thinking')
})

test('approval deadlines select the earliest future request across sessions', () => {
  assert.equal(APPROVAL_DELAY_MS, 300)
  const states = new SessionStates()
  assert.equal(states.nextApprovalDeadline(0), undefined)
  states.event('a', event('approval/asked', 0, { id: 'first' }), 100)
  states.event('b', event('approval/asked', 0, { id: 'second' }), 150)
  assert.equal(states.snapshot(399)[0].phase, 'running')
  assert.equal(states.nextApprovalDeadline(399), 400)
  assert.equal(states.snapshot(400)[0].phase, 'waiting')
  assert.equal(states.nextApprovalDeadline(400), 450)
  assert.equal(states.nextApprovalDeadline(450), undefined)
  states.event('b', end(1))
  assert.equal(states.snapshot(450)[1].phase, 'completed')
})

test('initialize never clobbers observed state and known turns survive idle status', () => {
  const states = new SessionStates()
  states.initialize('idle')
  assert.equal(states.snapshot()[0].phase, 'idle')
  states.event('a', start())
  states.event('a', call(1, 'one'))
  states.event('a', event('approval/asked', 2, { id: 'ask' }), 100)
  const observed = states.snapshot(400)[1]
  states.initialize('a', 'idle')
  states.initialize('a', 'running')
  states.status('a', 'idle')
  assert.deepEqual(states.snapshot(400)[1], observed)
  assert.equal(observed.phase, 'waiting', 'mature approval takes precedence over tools')
  states.event('a', start(3, 2))
  assert.deepEqual(states.snapshot(400)[1], {
    sessionId: 'a', turn: 2, phase: 'thinking', activeTools: 0, pendingApprovals: 0, result: null,
  })
})

test('new turn resets terminal result and result identity includes session, turn and seq', () => {
  const states = new SessionStates()
  states.event('a', end(7, 'error'))
  assert.deepEqual(states.snapshot()[0].result, { id: JSON.stringify(['a', 1, 7]), outcome: 'error' })
  states.event('a', start(8, 2))
  assert.equal(states.snapshot()[0].result, null)
  assert.equal(states.snapshot()[0].phase, 'thinking')
})

test('remove forgets projection and sequence history and tolerates missing sessions', () => {
  const states = new SessionStates()
  states.event('a', start(100))
  states.remove('a')
  states.remove('missing')
  assert.deepEqual(states.snapshot(), [])
  states.event('a', start(0, 2))
  assert.equal(states.snapshot()[0].turn, 2)
})
