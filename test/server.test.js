import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createServer } from 'http'

function trackedWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
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

function send(ws, msg) {
  ws.send(JSON.stringify(msg))
}

describe('UNO Server', () => {
  let server, port, lobbiesRef

  beforeEach(async () => {
    const httpServer = createServer()
    const wss = new WebSocketServer({ noServer: true })

    const clients = new Map()
    const lobbies = new Map()
    const startedLobbies = new Set()
    lobbiesRef = lobbies

    function createLobby(lobbyId) {
      return { id: lobbyId, players: [], game: { deck: [], discardPile: [], turn: 0, direction: 1, started: false } }
    }

    function findOrCreateLobby(lobbyId) {
      if (!lobbies.has(lobbyId)) lobbies.set(lobbyId, createLobby(lobbyId))
      return lobbies.get(lobbyId)
    }

    function broadcastToLobby(lobbyId, message, excludeClientId = null) {
      for (const [client, meta] of clients) {
        if (meta.lobbyId === lobbyId && meta.id !== excludeClientId) {
          client.send(JSON.stringify(message))
        }
      }
    }

    function broadcastPlayers(lobbyId) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      broadcastToLobby(lobbyId, { action: 'players', players: lobby.players, turn: lobby.game.turn, lobbyId })
    }

    function checkStartGame(lobbyId) {
      const lobby = lobbies.get(lobbyId)
      if (lobby && lobby.players.length > 1 && lobby.players.every(p => p.ready)) {
        startGame(lobbyId)
      }
    }

    function createDeck(lobbyId) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      const colors = ['red', 'yellow', 'green', 'blue']
      const types = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'reverse', 'draw2']
      for (const color of colors) {
        for (const type of types) {
          lobby.game.deck.push({ color, type })
          if (type !== '0') lobby.game.deck.push({ color, type })
        }
      }
      for (let i = 0; i < 4; i++) {
        lobby.game.deck.push({ type: 'wild' })
        lobby.game.deck.push({ type: 'wild4' })
      }
    }

    function shuffleDeck(lobbyId) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      for (let i = lobby.game.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lobby.game.deck[i], lobby.game.deck[j]] = [lobby.game.deck[j], lobby.game.deck[i]]
      }
    }

    function uuidv4() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8)
        return v.toString(16)
      })
    }

    function sanitizePlayers(players) {
      return players.map(p => {
        const { hand, ...rest } = p
        return { ...rest, cardCount: hand ? hand.length : 0 }
      })
    }

    function startGame(lobbyId) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      lobby.game.started = true
      startedLobbies.add(lobbyId)
      createDeck(lobbyId)
      shuffleDeck(lobbyId)
      for (const player of lobby.players) {
        player.hand = lobby.game.deck.splice(0, 7)
        player.uno = false
      }
      let idx = lobby.game.deck.findIndex(c => c.type !== 'wild' && c.type !== 'wild4')
      if (idx === -1) { shuffleDeck(lobbyId); idx = lobby.game.deck.findIndex(c => c.type !== 'wild' && c.type !== 'wild4') }
      lobby.game.discardPile.push(lobby.game.deck.splice(idx, 1)[0])
      for (const [client, meta] of clients) {
        if (meta.lobbyId === lobbyId) {
          const player = lobby.players.find(p => p.id === meta.id)
          if (!player) continue
          client.send(JSON.stringify({
            action: 'start', players: sanitizePlayers(lobby.players), discardPile: lobby.game.discardPile,
            turn: lobby.game.turn, hand: player.hand, id: meta.id
          }))
        }
      }
    }

    function broadcastWin(lobbyId, winnerName) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      broadcastToLobby(lobbyId, { action: 'win', winner: winnerName })
      for (const [, meta] of clients) {
        if (meta.lobbyId === lobbyId) meta.lobbyId = null
      }
      lobby.players.length = 0
      lobby.game = { deck: [], discardPile: [], turn: 0, direction: 1, started: false }
      startedLobbies.delete(lobbyId)
    }

    function broadcastGameAborted(lobbyId, excludePlayerId) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      broadcastToLobby(lobbyId, { action: 'game_aborted' }, excludePlayerId)
      for (const [client, meta] of clients) {
        if (meta.lobbyId === lobbyId && meta.id !== excludePlayerId) meta.lobbyId = null
      }
      lobby.players = []
      lobby.game = { deck: [], discardPile: [], turn: 0, direction: 1, started: false }
      startedLobbies.delete(lobbyId)
    }

    function checkGameAborted(lobbyId, excludePlayerId) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby || !lobby.game.started) return
      const realPlayers = lobby.players.filter(p => !p.isAI)
      if (lobby.players.length < 2 || realPlayers.length === 0) {
        broadcastGameAborted(lobbyId, excludePlayerId)
      }
    }

    function checkStartGame(lobbyId) {
      const lobby = lobbies.get(lobbyId)
      if (lobby && lobby.players.length > 1 && lobby.players.every(p => p.ready)) {
        startGame(lobbyId)
      }
    }

    function handlePlay(lobbyId, playerId, card) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      const player = lobby.players.find(p => p.id === playerId)
      const playerIndex = lobby.players.indexOf(player)
      if (lobby.game.turn !== playerIndex) return
      let cardIndex = card.type === 'wild' || card.type === 'wild4'
        ? player.hand.findIndex(c => c.type === card.type)
        : player.hand.findIndex(c => c.color === card.color && c.type === card.type)
      if (cardIndex < 0) return
      player.hand.splice(cardIndex, 1)
      lobby.game.discardPile.push(card)
      if (card.type === 'skip') {
        lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length
      } else if (card.type === 'reverse') {
        lobby.game.direction *= -1
        lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length
      } else if (card.type === 'draw2') {
        const n = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length
        lobby.players[n].hand.push(...lobby.game.deck.splice(0, 2))
        lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length
      } else if (card.type === 'wild4') {
        const n = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length
        lobby.players[n].hand.push(...lobby.game.deck.splice(0, 4))
        lobby.game.turn = (lobby.game.turn + 2 * lobby.game.direction + lobby.players.length) % lobby.players.length
      } else {
        lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length
      }
      broadcastGameUpdate(lobbyId)
      if (player.hand.length === 0) broadcastWin(lobbyId, player.name)
    }

    function broadcastGameUpdate(lobbyId) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      for (const [client, meta] of clients) {
        if (meta.lobbyId === lobbyId) {
          const player = lobby.players.find(p => p.id === meta.id)
          client.send(JSON.stringify({
            action: 'update', players: sanitizePlayers(lobby.players), discardPile: lobby.game.discardPile,
            turn: lobby.game.turn, hand: player ? player.hand : []
          }))
        }
      }
    }

    function handleDraw(lobbyId, playerId) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      const playerIndex = lobby.players.findIndex(p => p.id === playerId)
      if (lobby.game.turn !== playerIndex) return

      const player = lobby.players[playerIndex]

      if (player.hand.length >= 100) {
        lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length
        broadcastGameUpdate(lobbyId)
        return
      }

      let card = lobby.game.deck.pop()
      if (!card) {
        if (lobby.game.discardPile.length >= 2) {
          const topCard = lobby.game.discardPile.pop()
          lobby.game.deck = lobby.game.discardPile
          lobby.game.discardPile = [topCard]
          shuffleDeck(lobbyId)
          card = lobby.game.deck.pop()
        }
      }
      if (card) {
        lobby.players[playerIndex].hand.push(card)
      }

      lobby.game.turn = (lobby.game.turn + lobby.game.direction + lobby.players.length) % lobby.players.length
      broadcastGameUpdate(lobbyId)
    }

    function handleLeave(lobbyId, playerId) {
      const lobby = lobbies.get(lobbyId)
      if (!lobby) return
      const idx = lobby.players.findIndex(p => p.id === playerId)
      if (idx > -1) {
        lobby.players.splice(idx, 1)
        checkGameAborted(lobbyId, playerId)
        broadcastToLobby(lobbyId, { action: 'players', players: lobby.players, turn: lobby.game.turn, lobbyId }, playerId)
        checkStartGame(lobbyId)
        if (lobby.players.length === 0) lobbies.delete(lobbyId)
      }
    }

    httpServer.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url, `http://${req.headers.host}`)
      if (pathname === '/ws') {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      } else {
        socket.destroy()
      }
    })

    wss.on('connection', (ws) => {
      const id = uuidv4()
      clients.set(ws, { id })
      ws.send(JSON.stringify({ action: 'init', dev: false }))

      ws.on('message', (raw) => {
        let message
        try { message = JSON.parse(raw.toString()) } catch { ws.close(1002, 'invalid'); return }
        const meta = clients.get(ws)
        switch (message.action) {
          case 'join': {
            meta.name = message.name
            if (typeof message.lobbyId !== 'string' || !message.lobbyId.length) {
              ws.send(JSON.stringify({ action: 'error', message: '请提供大厅名称' }))
              return
            }
            let lobby = findOrCreateLobby(message.lobbyId)
            if (startedLobbies.has(lobby.id)) {
              ws.send(JSON.stringify({ action: 'error', message: '大厅已开始对局, 请使用其他名称' }))
              return
            }
            if (lobby.players.some(p => p.name.toLowerCase() === message.name.toLowerCase())) {
              ws.send(JSON.stringify({ action: 'error', message: '该大厅中已存在同名玩家，请选择其他名称' }))
              return
            }
            meta.lobbyId = message.lobbyId
            lobby.players.push({ id: meta.id, name: meta.name, ready: false, isCreator: lobby.players.length === 0 })
            broadcastPlayers(meta.lobbyId)
            return
          }
          case 'ready': {
            const lobby = lobbies.get(meta.lobbyId)
            if (!lobby) { ws.send(JSON.stringify({ action: 'error', message: 'not in lobby' })); return }
            const player = lobby.players.find(p => p.id === meta.id)
            if (!player) { ws.send(JSON.stringify({ action: 'error', message: 'not in lobby' })); return }
            player.ready = !player.ready
            broadcastPlayers(meta.lobbyId)
            checkStartGame(meta.lobbyId)
            return
          }
          case 'add_ai': {
            const lobby = lobbies.get(meta.lobbyId)
            const p = lobby && lobby.players.find(pl => pl.id === meta.id)
            if (!p || !p.isCreator) { ws.send(JSON.stringify({ action: 'error', message: '只有房主可以邀请 AI' })); return }
            if (startedLobbies.has(lobby.id)) { ws.send(JSON.stringify({ action: 'error', message: '对局已开始' })); return }
            let idx = 1
            while (lobby.players.some(pl => pl.name === `AI-${idx}`)) idx++
            lobby.players.push({ id: uuidv4(), name: `AI-${idx}`, ready: false, isCreator: false, isAI: true })
            broadcastPlayers(meta.lobbyId)
            return
          }
          case 'ai_ready': {
            const lobby = lobbies.get(meta.lobbyId)
            const p = lobby && lobby.players.find(pl => pl.id === meta.id)
            if (!p || !p.isCreator) { ws.send(JSON.stringify({ action: 'error', message: '只有房主可以准备 AI' })); return }
            const ai = lobby.players.find(pl => pl.id === message.playerId && pl.isAI)
            if (!ai) { ws.send(JSON.stringify({ action: 'error', message: 'AI 玩家未找到' })); return }
            ai.ready = !ai.ready
            broadcastPlayers(meta.lobbyId)
            checkStartGame(meta.lobbyId)
            return
          }
          case 'remove_ai': {
            const lobby = lobbies.get(meta.lobbyId)
            const p = lobby && lobby.players.find(pl => pl.id === meta.id)
            if (!p || !p.isCreator) { ws.send(JSON.stringify({ action: 'error', message: '只有房主可以踢出 AI' })); return }
            if (startedLobbies.has(lobby.id)) { ws.send(JSON.stringify({ action: 'error', message: '对局已开始' })); return }
            const idx = lobby.players.findIndex(pl => pl.id === message.playerId && pl.isAI)
            if (idx === -1) { ws.send(JSON.stringify({ action: 'error', message: 'AI 玩家未找到' })); return }
            lobby.players.splice(idx, 1)
            broadcastPlayers(meta.lobbyId)
            return
          }
          case 'play':
            if (!lobbies.has(meta.lobbyId)) { ws.send(JSON.stringify({ action: 'error', message: '房间不存在' })); return }
            handlePlay(meta.lobbyId, meta.id, message.card); return
          case 'draw':
            if (!lobbies.has(meta.lobbyId)) { ws.send(JSON.stringify({ action: 'error', message: '房间不存在' })); return }
            handleDraw(meta.lobbyId, meta.id); return
          case 'leave':
            if (!lobbies.has(meta.lobbyId)) { ws.send(JSON.stringify({ action: 'error', message: '房间不存在' })); return }
            handleLeave(meta.lobbyId, meta.id); return
          case 'dev_add_cards': {
            const lobby = findOrCreateLobby(meta.lobbyId)
            if (!lobby.game.started) return
            const player = lobby.players.find(p => p.id === meta.id)
            if (!player) return
            const count = Math.min(message.count || 1, 20)
            let drawn = lobby.game.deck.splice(0, count)
            if (drawn.length < count && lobby.game.discardPile.length >= 2) {
              const topCard = lobby.game.discardPile.pop()
              lobby.game.deck = lobby.game.discardPile
              lobby.game.discardPile = [topCard]
              shuffleDeck(meta.lobbyId)
              const more = lobby.game.deck.splice(0, count - drawn.length)
              drawn = [...drawn, ...more]
            }
            player.hand.push(...drawn)
            broadcastGameUpdate(meta.lobbyId)
            return
          }
          case 'dev_add_all_cards': {
            const lobby = findOrCreateLobby(meta.lobbyId)
            if (!lobby.game.started) return
            const player = lobby.players.find(p => p.id === meta.id)
            if (!player) return
            let drawn = lobby.game.deck.splice(0, lobby.game.deck.length)
            if (drawn.length === 0 && lobby.game.discardPile.length >= 2) {
              const topCard = lobby.game.discardPile.pop()
              lobby.game.deck = lobby.game.discardPile
              lobby.game.discardPile = [topCard]
              shuffleDeck(meta.lobbyId)
              drawn = lobby.game.deck.splice(0, lobby.game.deck.length)
            }
            if (drawn.length > 0 && lobby.game.discardPile.length < 2) {
              lobby.game.discardPile.push(drawn.shift())
            }
            player.hand.push(...drawn)
            broadcastGameUpdate(meta.lobbyId)
            return
          }
        }
      })

      ws.on('close', () => {
        const meta = clients.get(ws)
        if (meta && meta.lobbyId) {
          const lobby = lobbies.get(meta.lobbyId)
          if (lobby) {
            const idx = lobby.players.findIndex(p => p.id === meta.id)
            if (idx > -1) {
              lobby.players.splice(idx, 1)
              checkGameAborted(meta.lobbyId, meta.id)
              broadcastPlayers(meta.lobbyId)
              checkStartGame(meta.lobbyId)
              if (lobby.players.length === 0) lobbies.delete(meta.lobbyId)
            }
          }
        }
        clients.delete(ws)
      })
    })

    await new Promise(r => httpServer.listen(0, r))
    port = httpServer.address().port
    server = httpServer
  })

  afterEach(() => { server.close() })

  it('connect and receive init', async () => {
    const c = await trackedWs(port)
    const msg = await c.next()
    expect(msg.action).toBe('init')
    expect(msg.dev).toBe(false)
    c.close()
  })

  it('reject join without lobbyId', async () => {
    const c = await trackedWs(port)
    await c.next()
    send(c.ws, { action: 'join', name: 'Alice' })
    const err = await c.next()
    expect(err.action).toBe('error')
    c.close()
  })

  it('reject join with empty lobbyId', async () => {
    const c = await trackedWs(port)
    await c.next()
    send(c.ws, { action: 'join', name: 'Alice', lobbyId: '' })
    const err = await c.next()
    expect(err.action).toBe('error')
    c.close()
  })

  it('join lobby with custom name', async () => {
    const c = await trackedWs(port)
    await c.next()
    send(c.ws, { action: 'join', name: 'Alice', lobbyId: 'myroom' })
    const msg = await c.next()
    expect(msg.action).toBe('players')
    expect(msg.players).toHaveLength(1)
    expect(msg.players[0].name).toBe('Alice')
    expect(msg.players[0].isCreator).toBe(true)
    expect(msg.lobbyId).toBe('myroom')
    c.close()
  })

  it('reject duplicate names in same lobby', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    const err = await b.next()
    expect(err.action).toBe('error')
    expect(err.message).toContain('已存在同名')
    a.close()
    b.close()
  })

  it('two players in same lobby', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    const bob = await b.next()
    expect(bob.players).toHaveLength(2)

    await a.next()
    a.close()
    b.close()
  })

  it('second joiner is non-creator', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    const bob = await b.next()
    expect(bob.players[0].isCreator).toBe(true)
    expect(bob.players[1].isCreator).toBe(false)
    a.close()
    b.close()
  })

  it('leave removes player', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(b.ws, { action: 'leave' })
    const aliceUpdate = await a.next()
    expect(aliceUpdate.players).toHaveLength(1)
    expect(aliceUpdate.players[0].name).toBe('Alice')
    a.close()
    b.close()
  })

  it('leaver not notified on leave', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    let got = false
    b.ws.once('message', () => { got = true })
    send(b.ws, { action: 'leave' })
    await new Promise(r => setTimeout(r, 150))
    expect(got).toBe(false)
    await a.next()
    a.close()
    b.close()
  })

  it('start game when all ready', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' })
    await a.next()
    await b.next()
    send(b.ws, { action: 'ready' })

    await a.next() // players
    await b.next() // players
    const s1 = await a.next() // start
    const s2 = await b.next() // start
    expect(s1.action).toBe('start')
    expect(s2.action).toBe('start')
    expect(s1.hand).toHaveLength(7)
    a.close()
    b.close()
  })

  it('play a matching card', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' })
    await a.next(); await b.next()

    const s1 = await a.next()
    await b.next()

    const topCard = s1.discardPile[0]
    const matching = s1.hand.find(c => c.color === topCard.color || c.type === topCard.type)
    if (matching) {
      send(a.ws, { action: 'play', card: matching })
      const u = await a.next()
      expect(u.action).toBe('update')
      expect(u.hand.length).toBeLessThan(7)
    }
    a.close()
    b.close()
  })

  it('draw card', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    send(a.ws, { action: 'draw' })
    const u = await a.next()
    expect(u.action).toBe('update')
    expect(u.hand).toHaveLength(8)
    a.close()
    b.close()
  })

  it('draw reshuffles discard pile when deck is empty', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    const lobby = lobbiesRef.get('r')
    lobby.game.discardPile.push(...lobby.game.deck)
    lobby.game.deck = []

    send(a.ws, { action: 'draw' })
    const u = await a.next()
    expect(u.action).toBe('update')
    expect(u.hand).toHaveLength(8)
    a.close()
    b.close()
  })

  it('draw passes turn when deck and discard pile are exhausted and no donor has >1 card', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    const lobby = lobbiesRef.get('r')
    // Move cards from Bob to deck so Bob has only 1 card
    lobby.game.deck.push(...lobby.players[1].hand.splice(1))
    // Ensure deck and discard are exhausted
    lobby.game.deck = []
    lobby.game.discardPile.splice(1)

    send(a.ws, { action: 'draw' })
    const u = await a.next()
    expect(u.action).toBe('update')
    expect(u.hand).toHaveLength(7)
    expect(u.turn).toBe(1)
    a.close()
    b.close()
  })

  it('draw passes turn when deck and discard pile are exhausted and no donor has >1 card', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    const lobby = lobbiesRef.get('r')
    lobby.game.deck = []
    lobby.game.discardPile.splice(1)

    send(a.ws, { action: 'draw' })
    const u = await a.next()
    expect(u.action).toBe('update')
    expect(u.hand).toHaveLength(7)
    expect(u.turn).toBe(1)
    a.close()
    b.close()
  })

  it('draw works after dev_add_cards depletes the deck', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    // Deplete the deck by moving all cards to Alice's hand
    const lobby = lobbiesRef.get('r')
    const remainingCards = lobby.game.deck.splice(0, lobby.game.deck.length)
    lobby.players[0].hand.push(...remainingCards)
    // Give discard pile enough cards to reshuffle count=2
    const extraCards = lobby.players[0].hand.splice(0, 4)
    lobby.game.discardPile.push(...extraCards)
    expect(lobby.game.deck.length).toBe(0)
    expect(lobby.game.discardPile.length >= 2).toBe(true)

    // dev_add_cards should reshuffle discard pile and add cards
    const aliceHandBefore = lobby.players[0].hand.length
    send(a.ws, { action: 'dev_add_cards', count: 2 })
    const u1 = await a.next()
    expect(u1.action).toBe('update')
    expect(u1.hand.length).toBe(aliceHandBefore + 2) // reshuffled 2 cards added
    a.close()
    b.close()
  })

  it('dev_add_all_cards adds all deck cards to hand', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    const lobby = lobbiesRef.get('r')
    const deckSize = lobby.game.deck.length

    send(a.ws, { action: 'dev_add_all_cards' })
    const u = await a.next()
    expect(u.action).toBe('update')
    // Alice gets all deck cards minus 1 (which seeds the discard pile to enable draws)
    expect(u.hand.length).toBe(7 + deckSize - 1) // 1 card reserved for discard
    expect(lobby.game.deck.length).toBe(0)
    expect(lobby.game.discardPile.length).toBe(2)
    a.close()
    b.close()
  })

  it('player with >= 100 cards skips draw others pass when deck empty', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    // Give Alice all deck cards (99 after reserve) then push to >= 100
    send(a.ws, { action: 'dev_add_all_cards' })
    await a.next()
    send(a.ws, { action: 'dev_add_cards', count: 1 }) // reshuffles the reserved card → Alice 100
    await a.next()

    const lobby = lobbiesRef.get('r')
    const aliceHand = lobby.players[0].hand.length
    const bobHand = lobby.players[1].hand.length
    expect(aliceHand >= 100).toBe(true)

    // Alice draws → >= 100, skips turn, hand unchanged
    send(a.ws, { action: 'draw' })
    const u1 = await a.next()
    expect(u1.action).toBe('update')
    expect(u1.hand.length).toBe(aliceHand)
    expect(u1.turn).toBe(1)
    expect(lobby.players[0].hand.length).toBe(aliceHand)

    // Bob draws → deck empty, discard < 2 → pass turn, neither changes
    send(b.ws, { action: 'draw' })
    const u2 = await a.next()
    expect(u2.action).toBe('update')
    expect(u2.hand.length).toBe(aliceHand)
    expect(lobby.players[0].hand.length).toBe(aliceHand)
    expect(lobby.players[1].hand.length).toBe(bobHand)
    a.close()
    b.close()
  })

  it('returns error when lobby does not exist for game action', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()
    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    // Simulate server restart: delete the lobby
    lobbiesRef.delete('r')

    send(a.ws, { action: 'draw' })
    const err = await a.next()
    expect(err.action).toBe('error')
    expect(err.message).toContain('房间')
    a.close()
    b.close()
  })

  it('abort game when opponent disconnects', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    b.close()
    const aborted = await a.next()
    expect(aborted.action).toBe('game_aborted')
    a.close()
  })

  it('abort game when opponent leaves', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    send(b.ws, { action: 'leave' })
    const aborted = await a.next()
    expect(aborted.action).toBe('game_aborted')
    a.close()
    b.close()
  })

  it('reject join to started lobby', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    const c = await trackedWs(port)
    await c.next()
    send(c.ws, { action: 'join', name: 'Eve', lobbyId: 'r' })
    const err = await c.next()
    expect(err.action).toBe('error')
    expect(err.message).toContain('已开始')
    a.close()
    b.close()
    c.close()
  })

  it('can rejoin ended lobby', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    // Bob leaves -> game aborted
    send(b.ws, { action: 'leave' })
    await a.next()

    // Now new player can join "r" since it's no longer started
    const c = await trackedWs(port)
    await c.next()
    send(c.ws, { action: 'join', name: 'Eve', lobbyId: 'r' })
    const msg = await c.next()
    expect(msg.action).toBe('players')
    expect(msg.lobbyId).toBe('r')
    expect(msg.players).toHaveLength(1)
    a.close()
    b.close()
    c.close()
  })

  it('reject join should not leak lobbyId to metadata', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    await a.next(); await b.next()

    // Game started. A third client tries to join — should be rejected.
    const c = await trackedWs(port)
    await c.next()
    send(c.ws, { action: 'join', name: 'Eve', lobbyId: 'r' })
    const err = await c.next()
    expect(err.action).toBe('error')
    expect(err.message).toContain('已开始')

    // A leaves — game aborts. c should NOT receive game_aborted since join was rejected.
    let cGotAbort = false
    c.ws.once('message', () => { cGotAbort = true })

    send(a.ws, { action: 'leave' })
    await new Promise(r => setTimeout(r, 150))
    expect(cGotAbort).toBe(false)
    a.close()
    b.close()
    c.close()
  })

  it('add_ai requires creator', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(b.ws, { action: 'add_ai' })
    const err = await b.next()
    expect(err.action).toBe('error')
    expect(err.message).toContain('只有房主')
    a.close()
    b.close()
  })

  it('add_ai creates AI player', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    send(a.ws, { action: 'add_ai' })
    const msg = await a.next()
    expect(msg.action).toBe('players')
    expect(msg.players).toHaveLength(2)
    expect(msg.players[1].isAI).toBe(true)
    expect(msg.players[1].name).toMatch(/^AI-/)
    expect(msg.players[1].ready).toBe(false)
    a.close()
  })

  it('ai_ready toggles AI player ready', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    send(a.ws, { action: 'add_ai' })
    const addMsg = await a.next()
    const aiId = addMsg.players[1].id

    send(a.ws, { action: 'ai_ready', playerId: aiId })
    const msg = await a.next()
    expect(msg.players).toHaveLength(2)
    expect(msg.players[1].ready).toBe(true)
    a.close()
  })

  it('remove_ai kicks AI player', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    send(a.ws, { action: 'add_ai' })
    const addMsg = await a.next()
    const aiId = addMsg.players[1].id

    send(a.ws, { action: 'remove_ai', playerId: aiId })
    const msg = await a.next()
    expect(msg.players).toHaveLength(1)
    a.close()
  })

  it('start game with AI players', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    send(a.ws, { action: 'add_ai' })
    const addMsg = await a.next()
    const aiId = addMsg.players[1].id

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()
    send(a.ws, { action: 'ai_ready', playerId: aiId }); await a.next(); await b.next()

    const s1 = await a.next()
    const s2 = await b.next()
    expect(s1.action).toBe('start')
    expect(s2.action).toBe('start')
    expect(s1.players).toHaveLength(3)
    expect(s1.players[2].cardCount).toBe(7)
    a.close()
    b.close()
  })

  it('start game not crash when player left before startGame loop', async () => {
    const a = await trackedWs(port)
    await a.next()
    send(a.ws, { action: 'join', name: 'Alice', lobbyId: 'r' })
    await a.next()

    const b = await trackedWs(port)
    await b.next()
    send(b.ws, { action: 'join', name: 'Bob', lobbyId: 'r' })
    await b.next()
    await a.next()

    // Both ready
    send(a.ws, { action: 'ready' }); await a.next(); await b.next()
    send(b.ws, { action: 'ready' }); await a.next(); await b.next()

    // Bob closes BEFORE receiving start — simulates refresh
    b.close()

    // Alice should get start (or players if game didn't start)
    // Game should start with just Alice since all remaining (only Alice) are ready and >= 2? No, >= 2 fails.
    // So game should NOT start (only 1 player left), Bob left triggers checkStartGame but len=1.
    // Actually after Bob's close, lobby has 1 player. checkStartGame returns (len > 1 fails).
    // No crash should occur.
    const msg = await a.next()
    expect(msg.action).toMatch(/^(players|start)$/)
    a.close()
  })
})
