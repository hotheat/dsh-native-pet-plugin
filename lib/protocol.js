import { homedir } from 'node:os'
import { join } from 'node:path'

export const MAX_LINE_BYTES = 262144

const phases = new Set(['idle', 'running', 'thinking', 'working', 'waiting', 'completed', 'error', 'stopped'])
const outcomes = new Set(['completed', 'error', 'aborted', 'blocked', 'max-tokens', 'other'])
const nonempty = (value) => typeof value === 'string' && value.length > 0
const natural = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function object(value, keys) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && keys.every(key => Object.hasOwn(value, key))
}
function validSession(value) {
  if (!object(value, ['sessionId', 'turn', 'phase', 'activeTools', 'pendingApprovals', 'result'])) return false
  return nonempty(value.sessionId) && (value.turn === null || natural(value.turn))
    && typeof value.phase === 'string' && phases.has(value.phase)
    && natural(value.activeTools) && natural(value.pendingApprovals)
    && (value.result === null || (object(value.result, ['id', 'outcome'])
      && nonempty(value.result.id) && typeof value.result.outcome === 'string' && outcomes.has(value.result.outcome)))
}

/** Validate at the wire boundary, matching the upstream bridge decoder. */
export function decodeMessage(value) {
  if (typeof value !== 'object' || value === null || !('type' in value)) throw new Error('Invalid desktop pet message')
  if ('v' in value && value.v !== 1) throw new Error('Unsupported desktop pet protocol version')
  if (value.type === 'activity') {
    if (!object(value, ['type', 'provider', 'sessionId', 'turnId', 'eventId', 'kind', 'occurredAt', 'toolId'])) throw new Error('Invalid desktop pet activity fields')
    const activity = value
    if (typeof activity.provider !== 'string' || !['codex', 'claudeCode'].includes(activity.provider) || !nonempty(activity.sessionId) || !nonempty(activity.eventId)
      || !(activity.turnId === null || nonempty(activity.turnId)) || !(activity.toolId === null || nonempty(activity.toolId))
      || typeof activity.kind !== 'string' || !['sessionStarted', 'turnStarted', 'toolStarted', 'toolFinished', 'waiting', 'running', 'turnEnded', 'failed', 'interrupted', 'sessionEnded'].includes(activity.kind)
      || typeof activity.occurredAt !== 'number' || !Number.isFinite(activity.occurredAt) || activity.occurredAt < 0) throw new Error('Invalid desktop pet activity')
    return { type: 'activity', provider: activity.provider, sessionId: activity.sessionId, turnId: activity.turnId,
      eventId: activity.eventId, kind: activity.kind, occurredAt: activity.occurredAt, toolId: activity.toolId }
  }
  const snapshot = value.type === 'snapshot'
  if (!(snapshot ? object(value, ['type', 'sourceId', 'sourceLabel', 'seq', 'sessions'])
    : value.type === 'heartbeat' && object(value, ['type', 'sourceId', 'seq']))) throw new Error('Invalid desktop pet message fields')
  const fields = value
  if (!nonempty(fields.sourceId) || fields.sourceId.startsWith('hook:') || !natural(fields.seq) || fields.seq === 0) throw new Error('Invalid desktop pet source or sequence')
  if (!snapshot) return { type: 'heartbeat', sourceId: fields.sourceId, seq: fields.seq }
  if (!nonempty(fields.sourceLabel) || !Array.isArray(fields.sessions)
    || !fields.sessions.every(validSession)
    || new Set(fields.sessions.map(session => session.sessionId)).size !== fields.sessions.length) throw new Error('Invalid desktop pet session snapshot')
  const sessions = fields.sessions.map(session => ({
    sessionId: session.sessionId, turn: session.turn, phase: session.phase,
    activeTools: session.activeTools, pendingApprovals: session.pendingApprovals,
    result: session.result === null ? null : { id: session.result.id, outcome: session.result.outcome },
  }))
  return { type: 'snapshot', sourceId: fields.sourceId, sourceLabel: fields.sourceLabel, seq: fields.seq, sessions }
}

export function socketPath(runtimeDirectory = process.env.DSH_NATIVE_PET_RUNTIME_DIR) {
  return join(runtimeDirectory ?? join(homedir(), 'Library/Application Support/dsh-native-pet'), 'pet.sock')
}

export function encodeMessage(message) {
  const json = JSON.stringify(message)
  if (Buffer.byteLength(json, 'utf8') > MAX_LINE_BYTES) throw new Error('Desktop pet snapshot exceeds 262144 bytes')
  return `${json}\n`
}
