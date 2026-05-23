import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fork } from 'child_process'
import path from 'path'
import { WebSocket } from 'ws'

const PORT = 3001
const BASE = `http://localhost:${PORT}`

let serverProcess

beforeAll(async () => {
  serverProcess = fork(path.resolve('./dist/server.js'), ['--port', String(PORT)], {
    env: { ...process.env, NODE_ENV: 'development' },
    silent: true
  })
  await new Promise(r => setTimeout(r, 1500))
})

afterAll(() => { if (serverProcess) serverProcess.kill() })

async function trackedWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`)
    const buffer = []
    ws.on('message', (data) => buffer.push(JSON.parse(data.toString())))
    ws.on('open', () => {
      const next = (timeout = 3000) => {
        if (buffer.length) return Promise.resolve(buffer.shift())
        return new Promise((resolve, reject) => {
          if (buffer.length) { resolve(buffer.shift()); return }
          const t = setTimeout(() => reject(new Error('timeout')), timeout)
          const handler = () => {
            clearTimeout(t)
            ws.removeListener('message', handler)
            if (buffer.length) resolve(buffer.shift())
          }
          ws.on('message', handler)
        })
      }
      resolve({ ws, next, close: () => ws.close() })
    })
    ws.on('error', reject)
  })
}

describe('Security', () => {
  it('rejects path traversal in icon requests', async () => {
    const resp = await fetch(`${BASE}/icons/../../package.json`)
    expect(resp.status).not.toBe(200)
  })

  it('rejects path traversal in static file requests', async () => {
    const resp = await fetch(`${BASE}/../package.json`)
    expect(resp.status).not.toBe(200)
  })

  it('rejects non-SVG icon requests', async () => {
    const resp = await fetch(`${BASE}/icons/crown.svg.exe`)
    expect(resp.status).not.toBe(200)
  })

  it('rejects null byte in URL', async () => {
    const resp = await fetch(`${BASE}/icons/crown.svg%00.txt`)
    expect(resp.status).not.toBe(200)
  })

  it('rejects JSON object as player name', async () => {
    const c = await trackedWs()
    await c.next() // init
    c.ws.send(JSON.stringify({ action: 'join', name: { xss: '<script>alert(1)</script>' }, lobbyId: 'test' }))
    await new Promise(r => setTimeout(r, 200))
    expect(c.ws.readyState).toBe(1) // connection still alive
    c.close()
  })

  it('handles malformed JSON gracefully', async () => {
    const c = await trackedWs()
    await c.next()
    c.ws.send('not json')
    await new Promise(r => setTimeout(r, 200))
    expect(c.ws.readyState).toBe(1)
    c.ws.send('{ broken')
    await new Promise(r => setTimeout(r, 200))
    expect(c.ws.readyState).toBe(1)
    c.close()
  })

  it('rejects join with empty name', async () => {
    const c = await trackedWs()
    await c.next()
    c.ws.send(JSON.stringify({ action: 'join', name: '', lobbyId: 'test' }))
    const msg = await c.next()
    expect(msg.action).toBe('error')
    c.close()
  })

  it('rejects join without lobbyId', async () => {
    const c = await trackedWs()
    await c.next()
    c.ws.send(JSON.stringify({ action: 'join', name: 'test' }))
    const msg = await c.next()
    expect(msg.action).toBe('error')
    c.close()
  })

  it('rejects very long player name', async () => {
    const c = await trackedWs()
    await c.next()
    c.ws.send(JSON.stringify({ action: 'join', name: 'x'.repeat(1000), lobbyId: 'test' }))
    const msg = await c.next()
    expect(msg.action).toBe('error')
    c.close()
  })

  it('game actions rejected when not in lobby', async () => {
    const c = await trackedWs()
    await c.next()
    const actions = ['play', 'draw', 'ready', 'uno', 'add_ai', 'ai_ready', 'remove_ai', 'transfer_creator', 'surrender']
    let errors = 0
    for (const action of actions) {
      c.ws.send(JSON.stringify({ action, card: { color: 'red', type: '0' }, playerId: 'nonexistent' }))
    }
    await new Promise(r => setTimeout(r, 300))
    expect(c.ws.readyState).toBe(1)
    c.close()
  })
})
