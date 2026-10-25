import { socketPath } from './protocol.js'
import { SessionStates } from './session-state.js'
import { PetSocketClient } from './socket-client.js'

export const name = 'dsh-native-pet'

export function apply(ctx) {
  ctx.inject(['sessions', 'agents'], ctx => {
    const states = new SessionStates()
    const initialTitle = session => {
      try {
        const title = ctx.get('sessionProjections')?.stateOf(session, 'title')
        return typeof title === 'string' ? title : undefined
      } catch {
        return undefined
      }
    }
    const client = new PetSocketClient({
      socketPath: socketPath(), sessions: () => states.snapshot(),
      onError: error => ctx.logger.warn(`desktop pet: ${error.message}`),
    })
    let approvalTimer
    let disposed = false
    const changed = () => {
      if (disposed) return
      client.changed()
      clearTimeout(approvalTimer)
      approvalTimer = undefined
      const deadline = states.nextApprovalDeadline()
      if (deadline !== undefined) {
        approvalTimer = setTimeout(changed, Math.max(1, deadline - Date.now()))
        approvalTimer.unref()
      }
    }
    ctx.on('session/created', session => { states.initialize(session.id, ctx.agents.get(session.id)?.status, initialTitle(session)); changed() })
    ctx.on('session/disposed', session => { states.remove(session.id); changed() })
    ctx.on('session/event', (session, event) => { states.event(session.id, event); changed() })
    ctx.on('agent/status', ({ agent, status }) => { states.status(agent.id, status); changed() })
    // Register live observers before enumerating; initialize never overwrites observed state.
    for (const session of ctx.sessions.list()) states.initialize(session.id, ctx.agents.get(session.id)?.status, initialTitle(session))
    ctx.fiber.effect(() => () => {
      disposed = true
      clearTimeout(approvalTimer)
      client.stop()
    })
    client.start()
  })
}
