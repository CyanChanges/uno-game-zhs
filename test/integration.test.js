// Integration tests against the real (compiled) server. The unit-test suite
// in server.test.js uses an inline simulated server that does not implement
// chain-drawing, draw modes, or the turn-timeout features — those need the
// full server and are exercised here.
//
// The dev_* events used below (dev_give_card, dev_set_top, dev_set_chain,
// dev_clear_hand, dev_skip) only exist when NODE_ENV=development, which is
// what the forked server below is started with.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fork } from 'child_process'
import path from 'path'
import { WebSocket } from 'ws'

const PORT = 3002

let serverProcess

beforeAll(async () => {
  serverProcess = fork(path.resolve('./dist/server.js'), ['--port', String(PORT)], {
    env: { ...process.env, NODE_ENV: 'development' },
    silent: true,
  })
  await new Promise(r => setTimeout(r, 1500))
})

afterAll(() => { if (serverProcess) serverProcess.kill() })

// Open a client and return a small awaitable wrapper over the WebSocket so
// tests can `await c.next('update')` for the next message of a given action,
// or `await c.next()` for any next message. Messages that don't match the
// action filter are skipped (logged but discarded) so tests don't have to
// thread broadcast ordering manually.
async function openClient() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const buffer = []
    const waiters = []
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      buffer.push(msg)
      while (waiters.length && buffer.length) {
        const w = waiters[0]
        const idx = w.action ? buffer.findIndex(m => m.action === w.action) : 0
        if (idx === -1) break
        const found = buffer.splice(idx, 1)[0]
        waiters.shift()
        clearTimeout(w.timer)
        w.resolve(found)
      }
    })
    ws.on('open', () => {
      const next = (action, timeoutMs = 3000) => {
        return new Promise((res, rej) => {
          // Drain buffered first.
          if (buffer.length) {
            const idx = action ? buffer.findIndex(m => m.action === action) : 0
            if (idx !== -1) {
              const found = buffer.splice(idx, 1)[0]
              return res(found)
            }
          }
          const w = { action, resolve: res, reject: rej, timer: null }
          w.timer = setTimeout(() => {
            const i = waiters.indexOf(w)
            if (i !== -1) waiters.splice(i, 1)
            rej(new Error(`timeout waiting for ${action || 'any'}`))
          }, timeoutMs)
          waiters.push(w)
        })
      }
      const send = (msg) => ws.send(JSON.stringify(msg))
      const drain = () => buffer.splice(0, buffer.length)
      resolve({ ws, next, send, drain, close: () => ws.close() })
    })
    ws.on('error', reject)
  })
}

// Boilerplate: open two clients, join+ready them into the lobby, return both.
// `drawMode` lets tests pick chain vs. direct mode before the game starts.
async function startTwoPlayerGame(lobbyId, { drawMode = 'chain' } = {}) {
  const a = await openClient()
  const b = await openClient()
  await a.next('init'); await b.next('init')
  a.send({ action: 'join', name: 'Alice', lobbyId })
  await a.next('players')
  b.send({ action: 'join', name: 'Bob', lobbyId })
  // Both peers see a refreshed players list as the lobby fills up.
  await a.next('players'); await b.next('players')
  if (drawMode !== 'chain') {
    a.send({ action: 'set_draw_mode', mode: drawMode })
    await a.next('players'); await b.next('players')
  }
  a.send({ action: 'ready' })
  await a.next('players'); await b.next('players')
  b.send({ action: 'ready' })
  // ready broadcast then start
  await a.next('players'); await b.next('players')
  const startA = await a.next('start')
  const startB = await b.next('start')
  return { a, b, startA, startB }
}

// Find which client is up next and which card from the server-supplied top
// matches that player's hand. Returns the active client + matching card or
// null.
function whoseTurn(start, a, b) {
  const turnId = start.players[start.turn].id
  return turnId === start.id ? a : b
}

describe('Chain-drawing rules (bug #2 / #3)', () => {
  it('skip card breaks a chain by paying the penalty (chain mode)', async () => {
    // The bug was that `skip`/`reverse` silently zeroed `drawingCount` —
    // the breaker got off scot-free. Now they must absorb the penalty.
    const { a, b, startA } = await startTwoPlayerGame('chain-skip-' + Date.now(), {})
    const turnSocket = whoseTurn(startA, a, b)
    const offSocket = turnSocket === a ? b : a
    const top = startA.discardPile[startA.discardPile.length - 1]

    // Stage: clear the active player's hand, give them a same-color skip,
    // and force the lobby into a chain with 4 pending penalty cards.
    turnSocket.send({ action: 'dev_clear_hand' })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_give_card', card: { color: top.color, type: 'skip' } })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_set_chain', count: 4 })
    const chainUpdate = await turnSocket.next('update')
    expect(chainUpdate.gameState).toBe(1)
    expect(chainUpdate.drawingCount).toBe(4)

    const handBefore = chainUpdate.hand.length
    turnSocket.send({ action: 'play', card: { color: top.color, type: 'skip' } })
    const after = await turnSocket.next('update')
    // Active player must have absorbed the chain (hand grew by 4 minus the
    // played skip card). Without the fix this would be `handBefore - 1`.
    expect(after.hand.length).toBe(handBefore - 1 + 4)
    // Chain state cleared.
    expect(after.gameState).toBe(0)
    expect(after.drawingCount).toBe(0)
    a.close(); b.close()
  })

  it('reverse card breaks a chain by paying the penalty (chain mode)', async () => {
    const { a, b, startA } = await startTwoPlayerGame('chain-rev-' + Date.now())
    const turnSocket = whoseTurn(startA, a, b)
    const top = startA.discardPile[startA.discardPile.length - 1]
    turnSocket.send({ action: 'dev_clear_hand' })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_give_card', card: { color: top.color, type: 'reverse' } })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_set_chain', count: 6 })
    const chainUpdate = await turnSocket.next('update')
    const handBefore = chainUpdate.hand.length
    turnSocket.send({ action: 'play', card: { color: top.color, type: 'reverse' } })
    const after = await turnSocket.next('update')
    expect(after.hand.length).toBe(handBefore - 1 + 6)
    expect(after.gameState).toBe(0)
    expect(after.drawingCount).toBe(0)
    a.close(); b.close()
  })

  it('regular number card breaks chain by paying penalty (chain mode)', async () => {
    const { a, b, startA } = await startTwoPlayerGame('chain-num-' + Date.now())
    const turnSocket = whoseTurn(startA, a, b)
    const top = startA.discardPile[startA.discardPile.length - 1]
    turnSocket.send({ action: 'dev_clear_hand' })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_give_card', card: { color: top.color, type: '5' } })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_set_chain', count: 2 })
    const chainUpdate = await turnSocket.next('update')
    const handBefore = chainUpdate.hand.length
    turnSocket.send({ action: 'play', card: { color: top.color, type: '5' } })
    const after = await turnSocket.next('update')
    expect(after.hand.length).toBe(handBefore - 1 + 2)
    expect(after.gameState).toBe(0)
    a.close(); b.close()
  })

  it('wild (no number) breaks chain by paying penalty (chain mode)', async () => {
    // Bug #2: the server already broke the chain via wild cards but the
    // CLIENT didn't show a confirm. Server-side correctness is still
    // worth covering — a wild *must* trigger penalty in chain mode.
    const { a, b, startA } = await startTwoPlayerGame('chain-wild-' + Date.now())
    const turnSocket = whoseTurn(startA, a, b)
    turnSocket.send({ action: 'dev_clear_hand' })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_give_card', card: { type: 'wild' } })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_set_chain', count: 4 })
    const chainUpdate = await turnSocket.next('update')
    const handBefore = chainUpdate.hand.length
    // Wild requires a color pick; the server only verifies type for wilds.
    turnSocket.send({ action: 'play', card: { color: 'red', type: 'wild' } })
    const after = await turnSocket.next('update')
    expect(after.hand.length).toBe(handBefore - 1 + 4)
    expect(after.gameState).toBe(0)
    a.close(); b.close()
  })

  it('draw2 extends the chain instead of paying it (chain mode)', async () => {
    const { a, b, startA } = await startTwoPlayerGame('chain-extend-' + Date.now())
    const turnSocket = whoseTurn(startA, a, b)
    const offSocket = turnSocket === a ? b : a
    const top = startA.discardPile[startA.discardPile.length - 1]
    turnSocket.send({ action: 'dev_clear_hand' })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_give_card', card: { color: top.color, type: 'draw2' } })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_set_chain', count: 2 })
    const chainUpdate = await turnSocket.next('update')
    const handBefore = chainUpdate.hand.length

    turnSocket.send({ action: 'play', card: { color: top.color, type: 'draw2' } })
    const after = await turnSocket.next('update')
    // Chain extended, breaker not penalized: hand simply -1.
    expect(after.hand.length).toBe(handBefore - 1)
    expect(after.gameState).toBe(1)
    expect(after.drawingCount).toBe(4) // 2 + 2
    a.close(); b.close()
  })
})

describe('Direct draw mode', () => {
  it('draw2 in direct mode immediately deals 2 to next player', async () => {
    const { a, b, startA } = await startTwoPlayerGame('direct-d2-' + Date.now(), { drawMode: 'direct' })
    const turnSocket = whoseTurn(startA, a, b)
    const offSocket = turnSocket === a ? b : a
    const top = startA.discardPile[startA.discardPile.length - 1]
    turnSocket.send({ action: 'dev_clear_hand' })
    await turnSocket.next('update')
    turnSocket.send({ action: 'dev_give_card', card: { color: top.color, type: 'draw2' } })
    const giveUpdate = await turnSocket.next('update')
    const offId = startA.players[(startA.turn + 1) % startA.players.length].id
    const offCardsBefore = giveUpdate.players.find(p => p.id === offId).cardCount

    turnSocket.send({ action: 'play', card: { color: top.color, type: 'draw2' } })
    // Listen on the player who issued the play — server fans the broadcast
    // out to everyone but the off socket's queue may already contain stale
    // updates from earlier dev_* mutations.
    const after = await turnSocket.next('update', 5000)
    const offCardsAfter = after.players.find(p => p.id === offId).cardCount
    expect(offCardsAfter).toBe(offCardsBefore + 2)
    // Direct mode never enters the drawing state.
    expect(after.gameState).toBe(0)
    expect(after.drawingCount).toBe(0)
    a.close(); b.close()
  })
})

describe('Turn timeout broadcast (task #5)', () => {
  it('broadcasts a turnDeadline on the start frame', async () => {
    const { a, b, startA, startB } = await startTwoPlayerGame('timeout-deadline-' + Date.now())
    expect(typeof startA.turnDeadline).toBe('number')
    expect(typeof startB.turnDeadline).toBe('number')
    // Deadline is in the near future (within 60s of now).
    expect(startA.turnDeadline).toBeGreaterThan(Date.now())
    expect(startA.turnDeadline).toBeLessThan(Date.now() + 60_000)
    a.close(); b.close()
  })

  it('updates the deadline on each turn change', async () => {
    const { a, b, startA } = await startTwoPlayerGame('timeout-refresh-' + Date.now())
    const turnSocket = whoseTurn(startA, a, b)
    const top = startA.discardPile[startA.discardPile.length - 1]
    turnSocket.send({ action: 'dev_give_card', card: { color: top.color, type: '7' } })
    const give = await turnSocket.next('update')
    const before = give.turnDeadline
    // Wait briefly so the deadline math is observably different.
    await new Promise(r => setTimeout(r, 50))
    turnSocket.send({ action: 'play', card: { color: top.color, type: '7' } })
    const after = await turnSocket.next('update')
    expect(typeof after.turnDeadline).toBe('number')
    expect(after.turnDeadline).toBeGreaterThan(before)
    a.close(); b.close()
  })

  // Security regression: a player must NOT be able to refresh / reconnect
  // mid-turn to reset the auto-draw timer. The deadline is locked to the
  // turn instance, not the live socket — a reconnect within the same
  // turn must resume the existing budget, not mint a fresh one.
  it('reconnect within the same turn does NOT reset the deadline', async () => {
    const { a, b, startA } = await startTwoPlayerGame('timeout-refresh-exploit-' + Date.now())
    const turnSocket = whoseTurn(startA, a, b)
    const turnIsA = turnSocket === a
    const turnPlayerId = turnIsA ? startA.id : startA.players.find(p => p.id !== startA.id).id

    const initialDeadline = startA.turnDeadline
    expect(typeof initialDeadline).toBe('number')

    // Wait long enough that a "naive reset" would be obvious in the
    // post-reconnect deadline (~250ms).
    await new Promise(r => setTimeout(r, 300))

    // Disconnect the active player and immediately reconnect with the
    // same playerId — exactly what `location.reload()` triggers in the
    // browser client.
    turnSocket.close()
    await new Promise(r => setTimeout(r, 100))

    // Re-open the WS and send `reconnect` with the saved playerId.
    const reborn = await openClient()
    await reborn.next('init')
    reborn.send({ action: 'reconnect', playerId: turnPlayerId })
    // The reconnect handler emits init → players → start (game in flight).
    await reborn.next('init')
    const start2 = await reborn.next('start')

    // The deadline shipped on the post-reconnect start frame must be
    // within a tight window of the original (small clock drift from
    // setTimeout re-arm is OK; minting a fresh PLAY_TIMEOUT_MS budget
    // would put it ~PLAY_TIMEOUT_MS / 3 later).
    expect(typeof start2.turnDeadline).toBe('number')
    expect(start2.turnDeadline).toBeLessThanOrEqual(initialDeadline + 50)
    expect(start2.turnDeadline).toBeGreaterThanOrEqual(initialDeadline - 50)

    reborn.close()
    if (turnIsA) b.close(); else a.close()
  })
})

describe('Server validates dev events (task #8)', () => {
  it('dev_set_top before game start is rejected', async () => {
    // dev_set_top before a started game should yield a GAME_NOT_STARTED
    // error rather than silently doing anything.
    const lobbyId = 'devval-' + Date.now()
    const a = await openClient()
    await a.next('init')
    a.send({ action: 'join', name: 'Alice', lobbyId })
    await a.next('players')
    a.send({ action: 'dev_set_top', card: { color: 'red', type: '0' } })
    const err = await a.next('error')
    expect(err.action).toBe('error')
    expect(err.errorKey).toBe('GAME_NOT_STARTED')
    a.close()
  })
})
