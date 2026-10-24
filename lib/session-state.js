const outcomes = new Set(['completed', 'error', 'aborted', 'blocked', 'max-tokens'])
export const APPROVAL_DELAY_MS = 300

/** A live projection only: no transcript reads and no task content retained. */
export class SessionStates {
  sessions = new Map()

  initialize(sessionId, status = 'idle') {
    if (this.sessions.has(sessionId)) return
    this.sessions.set(sessionId, {
      sessionId, turn: null, running: status === 'running', detailsKnown: false,
      lastSeq: -1, tools: new Set(), approvals: new Map(), result: null, terminal: null,
    })
  }

  remove(sessionId) { this.sessions.delete(sessionId) }

  status(sessionId, status) {
    this.initialize(sessionId, status)
    const state = this.sessions.get(sessionId)
    if (status === 'running') {
      state.running = true
      if (state.terminal !== null) {
        state.turn = null
        state.detailsKnown = false
        state.terminal = null
        state.result = null
      }
    } else if (!state.detailsKnown || state.terminal !== null) {
      state.running = false
      state.tools.clear()
      state.approvals.clear()
    }
  }

  event(sessionId, event, now = Date.now()) {
    this.initialize(sessionId)
    const state = this.sessions.get(sessionId)
    if (event.seq <= state.lastSeq) return
    state.lastSeq = event.seq
    switch (event.type) {
      case 'turn/start':
        state.turn = event.data.turn
        state.running = true
        state.detailsKnown = true
        state.tools.clear()
        state.approvals.clear()
        state.result = null
        state.terminal = null
        break
      case 'tool/call':
        if (state.terminal !== null) break
        state.turn = event.data.turn
        state.running = true
        state.tools.add(event.data.callId)
        break
      case 'tool/result':
        if (state.terminal !== null) break
        state.turn = event.data.turn
        state.running = true
        state.tools.delete(event.data.message.toolCallId)
        break
      case 'approval/asked':
        if (state.terminal === null) {
          state.running = true
          state.approvals.set(event.data.id, now)
        }
        break
      case 'approval/decided':
        state.approvals.delete(event.data.id)
        break
      case 'turn/end': {
        state.turn = event.data.turn
        state.running = false
        state.tools.clear()
        state.approvals.clear()
        const kind = event.data.reason.kind
        const outcome = outcomes.has(kind) ? kind : 'other'
        state.result = { id: JSON.stringify([sessionId, state.turn, event.seq]), outcome }
        state.terminal = outcome === 'completed' ? 'completed' : outcome === 'error' ? 'error' : 'stopped'
        break
      }
    }
  }

  snapshot(now = Date.now()) {
    return [...this.sessions.values()].map(state => {
      let phase
      if (state.terminal !== null) phase = state.terminal
      else if ([...state.approvals.values()].some(time => now - time >= APPROVAL_DELAY_MS)) phase = 'waiting'
      else if (state.tools.size > 0) phase = 'working'
      else if (state.running) phase = state.detailsKnown ? 'thinking' : 'running'
      else phase = 'idle'
      return {
        sessionId: state.sessionId, turn: state.turn, phase,
        activeTools: state.tools.size, pendingApprovals: state.approvals.size, result: state.result,
      }
    })
  }

  nextApprovalDeadline(now = Date.now()) {
    let deadline
    for (const state of this.sessions.values()) {
      for (const time of state.approvals.values()) {
        const candidate = time + APPROVAL_DELAY_MS
        if (candidate > now && (deadline === undefined || candidate < deadline)) deadline = candidate
      }
    }
    return deadline
  }
}
