import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decodeMessage, encodeMessage, MAX_LINE_BYTES } from '../lib/protocol.js'

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const valid = [...read('../fixtures/snapshots.json'), ...read('../fixtures/activity.json')]
const invalid = read('../fixtures/invalid-messages.json')

for (const fixture of valid) {
  test(`contract accepts shared ${fixture.name}`, () => {
    const encoded = encodeMessage(decodeMessage(fixture.message))
    assert.deepEqual(decodeMessage(JSON.parse(encoded)), decodeMessage(fixture.message))
    assert.equal(Object.hasOwn(JSON.parse(encoded), 'v'), false)
    assert.equal(encoded.includes('"optional"'), false)
    assert.equal(encoded.at(-1), '\n')
  })
}
for (const fixture of invalid) {
  test(`contract rejects shared ${fixture.name}`, () => {
    assert.throws(() => decodeMessage(fixture.message))
  })
}
test('encoded size uses UTF-8 bytes and limits only at IO', () => {
  const message = { type: 'snapshot', sourceId: 'a', sourceLabel: '中'.repeat(MAX_LINE_BYTES / 2), seq: 1, sessions: [] }
  assert.throws(() => encodeMessage(message), /exceeds/)
  message.sourceLabel = 'DSH'
  assert.doesNotThrow(() => encodeMessage(message))
})

test('snapshot rejects duplicate sessionId', () => {
  const session = { sessionId: 'same', turn: 1, phase: 'thinking', activeTools: 0, pendingApprovals: 0, result: null }
  const message = { type: 'snapshot', sourceId: 'dsh', sourceLabel: 'DSH', seq: 1, sessions: [session, { ...session, turn: 2 }] }
  assert.throws(() => decodeMessage(message), /session snapshot/)
  assert.doesNotThrow(() => decodeMessage({ ...message, sessions: [session, { ...session, sessionId: 'other' }] }))
})
