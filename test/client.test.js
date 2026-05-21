import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from 'playwright'
import { fork } from 'child_process'
import path from 'path'

const BASE = 'http://localhost:3000'

let browser, serverProcess

beforeAll(async () => {
  serverProcess = fork(path.resolve('./dist/server.js'), [], {
    env: { ...process.env, NODE_ENV: 'development' },
    silent: true
  })
  serverProcess.stdout.on('data', d => process.stdout.write(`[server] ${d}`))
  serverProcess.stderr.on('data', d => process.stderr.write(`[server-err] ${d}`))
  await new Promise(r => setTimeout(r, 1500))
  browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
  if (browser) await browser.close()
  if (serverProcess) serverProcess.kill()
})

async function wait(ms) {
  const { promise, resolve } = Promise.withResolvers()
  setTimeout(resolve, ms)
  return promise
}

describe('UNO Client', () => {
  it('loads and shows join form', async () => {
    const page = await browser.newPage()
    await page.goto(BASE)
    await page.waitForSelector('#name')
    await page.waitForSelector('#join')
    expect(await page.isVisible('#name')).toBe(true)
    expect(await page.isVisible('#join')).toBe(true)
    await page.close()
  })

  it('shows (已准备) after player readies and state persists after opponent disconnects', async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    // Join lobby
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', 'test1')
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')

    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', 'test1')
    await pageB.click('#join')

    // Wait for both to see each other
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll('#players li')
      return items.length === 2
    })
    await pageB.waitForFunction(() => {
      const items = document.querySelectorAll('#players li')
      return items.length === 2
    })

    // Alice clicks ready → should show (已准备)
    await pageA.click('#ready')
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll('#players li')
      if (items.length === 0) return false
      return items[0].textContent.indexOf('（已准备）') !== -1
    })

    const aliceName = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
    expect(aliceName).toContain('（已准备）')

    // Bob disconnect
    await pageB.close()

    // Wait for Bob to appear as disconnected
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll('#players li')
      return items.length === 2 && items[1].classList.contains('disconnected')
    }, { timeout: 10000 })

    // Alice's ready should persist after Bob disconnects (countdown interval shouldn't corrupt it)
    await wait(2500)
    const aliceName1 = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
    expect(aliceName1).toContain('（已准备）')

    // Alice clicks ready again → should toggle to NOT ready
    await pageA.click('#ready')
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll('#players li')
      if (items.length === 0) return false
      return items[0].textContent.indexOf('（已准备）') === -1
    })

    const aliceName2 = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
    expect(aliceName2).not.toContain('（已准备）')

    await pageA.close()
  })

  it('full flow: B disconnects → A readies (stays ready) → B reconnects → B readies → game starts', { timeout: 45000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'flow-' + Date.now()

    // 1-2. A creates room, B joins
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li', { timeout: 5000 })

    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')

    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2, { timeout: 5000 })
    await pageB.waitForFunction(() => document.querySelectorAll('#players li').length === 2, { timeout: 5000 })

    // 3. B closes tab (disconnect)
    await pageB.close()
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll('#players li')
      return items.length === 2 && items[1].classList.contains('disconnected')
    }, { timeout: 10000 })

    // 4. A clicks ready
    await pageA.click('#ready')
    // Wait for ready button to confirm (changes from "就绪" to "取消准备")
    await pageA.waitForFunction(() => {
      const btn = document.getElementById('ready')
      return btn && btn.textContent === '取消准备'
    }, { timeout: 5000 })

    // 5. A stays ready — retry until stable
    for (let i = 0; i < 10; i++) {
      await pageA.waitForTimeout(300)
      const btn = await pageA.$eval('#ready', el => el.textContent)
      if (btn === '取消准备') break
    }
    const btnText = await pageA.$eval('#ready', el => el.textContent)
    expect(btnText).toBe('取消准备')
    const aliceName = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
    expect(aliceName).toContain('（已准备）')

    // 6. B reconnects (new page)
    const pageB2 = await browser.newPage()
    await pageB2.goto(BASE)
    await pageB2.fill('#name', 'Bob')
    await pageB2.fill('#lobby-id', lobbyId)
    await pageB2.click('#join')
    await pageB2.waitForFunction(() => document.querySelectorAll('#players li').length === 2, { timeout: 5000 })
    // Wait for B to be reconnected (not disconnected)
    await pageB2.waitForFunction(() => {
      const items = document.querySelectorAll('#players li')
      if (items.length < 2) return false
      return items.length >= 2 && !items[1].classList.contains('disconnected')
    }, { timeout: 5000 })

    const aliceReady2 = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
    expect(aliceReady2).toContain('（已准备）')

    // 7. B clicks ready → game starts
    await pageB2.click('#ready')

    // Wait for game to appear for both players
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none' && el.style.display !== ''
    }, { timeout: 10000 })
    await pageB2.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none' && el.style.display !== ''
    }, { timeout: 10000 })

    await pageA.close()
    await pageB2.close()
  })

  it('draw increases card count during normal play', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'draw-' + Date.now()
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)

    await pageA.click('#ready')
    await pageB.click('#ready')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    const getCardCount = async (page) => (await page.$$('#player-hand .card')).length
    const isMyTurn = async (page) => await page.evaluate(() => {
      const el = document.getElementById('turn-indicator');
      return el ? el.classList.contains('my-turn') : false;
    })

    // If B goes first, B draws to pass turn to A
    if (!(await isMyTurn(pageA))) {
      await pageB.waitForFunction(() => {
        const el = document.getElementById('turn-indicator');
        return el ? el.classList.contains('my-turn') : false;
      }, { timeout: 10000 })
      await pageB.click('#draw-card')
      await pageA.waitForTimeout(500)
    }

    // A draws → gets 1 card (normal draw, < 100 cards)
    const aBefore = await getCardCount(pageA)
    await pageA.click('#draw-card')
    await pageA.waitForTimeout(500)
    // Turn passes to B
      await pageB.waitForFunction(() => {
        const el = document.getElementById('turn-indicator');
        return el ? el.classList.contains('my-turn') : false;
      }, { timeout: 10000 })
    const aAfter = await getCardCount(pageA)
    expect(aAfter).toBe(aBefore + 1)

    await pageA.close()
    await pageB.close()
  })

  it('max hand 100: draw skips when >= 100, draw works after dropping below', { timeout: 45000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'maxhand-' + Date.now()
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)

    await pageA.click('#ready')
    await pageB.click('#ready')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    const isMyTurn = async (page) => await page.evaluate(() => {
      const el = document.getElementById('turn-indicator');
      return el ? el.classList.contains('my-turn') : false;
    })
    const getCardCount = async (page) => (await page.$$('#player-hand .card')).length

    // Ensure it is A's turn (A is first player)
    if (!(await isMyTurn(pageA))) {
      await pageB.waitForFunction(() => {
        const el = document.getElementById('turn-indicator');
        return el ? el.classList.contains('my-turn') : false;
      }, { timeout: 10000 })
      await pageB.click('#draw-card')
      await pageA.waitForTimeout(500)
    }

    // Let B remove 1 card first to increase discard to 2, so reshuffle works later
    await pageB.evaluate(() => { sendMessage({ action: 'dev_remove_cards', count: 1 }); })
    await pageA.waitForTimeout(500)

    // A: use dev_add_all_cards to get the full deck (no reserve, gives all 93 remaining)
    //     A already has 7 cards → total 7 + 93 = 100. Deck=0, Discard=2
    await pageA.evaluate(() => { sendMessage({ action: 'dev_add_all_cards' }); })
    await pageA.waitForTimeout(500)

    const aBeforeDraw = await getCardCount(pageA)
    expect(aBeforeDraw).toBeGreaterThanOrEqual(100)

    // Step 3: A clicks draw → should skip (>= MAX_HAND_CARDS), hand stays same, turn passes to B
    await pageA.click('#draw-card')
    await pageA.waitForTimeout(800)
    await pageB.waitForFunction(() => {
      const el = document.getElementById('turn-indicator');
      return el ? el.classList.contains('my-turn') : false;
    }, { timeout: 10000 })
    const aAfterSkip = await getCardCount(pageA)
    expect(aAfterSkip).toBe(aBeforeDraw)

    // Step 4: B draws → discard has 2 cards → reshuffle gives B a card
    const bBeforeDraw = await getCardCount(pageB)
    await pageB.click('#draw-card')
    await pageB.waitForTimeout(500)
    await pageA.waitForFunction(() => {
      const el = document.getElementById('turn-indicator');
      return el ? el.classList.contains('my-turn') : false;
    }, { timeout: 10000 })
    const bAfterDraw = await getCardCount(pageB)
    expect(bAfterDraw).toBeGreaterThan(bBeforeDraw)

    // Step 5: A removes 1 card (simulates playing a card) → A < 100
    await pageA.evaluate(() => { sendMessage({ action: 'dev_remove_cards', count: 1 }); })
    await pageA.waitForTimeout(500)
    const aBeforeDraw2 = await getCardCount(pageA)
    expect(aBeforeDraw2).toBeLessThan(100)

    // Step 6: A clicks draw → should now get +1 card
    await pageA.click('#draw-card')
    await pageA.waitForTimeout(500)
    await pageB.waitForFunction(() => {
      const el = document.getElementById('turn-indicator');
      return el ? el.classList.contains('my-turn') : false;
    }, { timeout: 10000 })
    const aAfterDraw2 = await getCardCount(pageA)
    expect(aAfterDraw2).toBe(aBeforeDraw2 + 1)

    await pageA.close()
    await pageB.close()
  })

  it('reconnected player card count shows after disconnect and rejoin', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'reconn-' + Date.now()
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)

    await pageA.click('#ready')
    await pageB.click('#ready')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })
    await pageB.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // A should see B's card count initially
    const initialDisplay = await pageA.$eval('#opponent-hands .player', el => el.textContent)
    expect(initialDisplay).toMatch(/（\d+ 张牌）/)

    // B closes page (disconnect)
    const bobId = await pageB.evaluate(() => localStorage.getItem('unoPlayerId'))
    await pageB.close()

    // Wait for A to see B as disconnected (processClose fires)
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll('#opponent-hands .player')
      return items.length >= 1 && items[0].classList.contains('disconnected')
    }, { timeout: 10000 })

    // After disconnect, A should still see B's card count (game update from processClose)
    const disconnectedDisplay = await pageA.$eval('#opponent-hands .player', el => el.textContent)
    expect(disconnectedDisplay).toMatch(/（\d+ 张牌）/)

    // B2: open new page and manually trigger reconnect
    const pageB2 = await browser.newPage()
    await pageB2.goto(BASE)
    await pageB2.waitForSelector('#name')
    // Wait for WebSocket to connect, then send reconnect
    await pageB2.waitForFunction(() => {
      return typeof ws !== 'undefined' && ws !== null && ws.readyState === 1
    }, { timeout: 5000 })
    await pageB2.evaluate((id) => {
      sendMessage({ action: 'reconnect', playerId: id })
    }, bobId)

    // B2 should receive start and show game
    await pageB2.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // A should see B's card count after reconnect (game update from reconnect handler)
    await pageA.waitForFunction(() => {
      const items = document.querySelectorAll('#opponent-hands .player')
      for (let i = 0; i < items.length; i++) {
        const text = items[i].textContent || ''
        if (text.includes('张牌') && !items[i].classList.contains('disconnected')) {
          return true
        }
      }
      return false
    }, { timeout: 10000 })

    const reconnectedDisplay = await pageA.$eval('#opponent-hands .player', el => el.textContent)
    expect(reconnectedDisplay).toMatch(/（\d+ 张牌）/)

    await pageA.close()
    await pageB2.close()
  })

  it('name and lobby ID saved to localStorage on input', async () => {
    const page = await browser.newPage()
    await page.goto(BASE)
    await page.waitForSelector('#name')

    // Type something and verify localStorage updates
    await page.fill('#name', 'TestPlayer')
    const name1 = await page.evaluate(() => localStorage.getItem('unoPlayerName'))
    expect(name1).toBe('TestPlayer')

    await page.fill('#lobby-id', 'TestLobby')
    const lobby1 = await page.evaluate(() => localStorage.getItem('unoLobbyId'))
    expect(lobby1).toBe('TESTLOBBY') // uppercased by input listener

    // Change and verify
    await page.fill('#name', 'Player2')
    const name2 = await page.evaluate(() => localStorage.getItem('unoPlayerName'))
    expect(name2).toBe('Player2')

    await page.close()
  })

  it('turn order display shows after game starts', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'order-' + Date.now()
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)

    await pageA.click('#ready')
    await pageB.click('#ready')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // Check turn-order element exists with player names
    const orderText = await pageA.evaluate(() => {
      const el = document.getElementById('turn-order')
      return el ? el.textContent : null
    })
    expect(orderText).toBeTruthy()
    expect(orderText).toContain('Alice')
    expect(orderText).toContain('Bob')
    // Should show direction arrow
    expect(orderText).toContain('▸')

    await pageA.close()
    await pageB.close()
  })

  it('leaving player does not receive lobby updates after leaving', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'leave-' + Date.now()
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)

    // A leaves the lobby
    await pageA.click('#leave-lobby')
    await pageA.waitForSelector('#modal-ok-btn', { timeout: 3000 })
    await pageA.click('#modal-ok-btn')

    // A should return to join form
    await pageA.waitForFunction(() => {
      const el = document.getElementById('join')
      return el && !el.disabled
    }, { timeout: 5000 })

    // Verify A's localStorage reflects left state
    const leftFlag = await pageA.evaluate(() => localStorage.getItem('unoLeftLobby'))
    expect(leftFlag).toBe('true')
    const noId = await pageA.evaluate(() => localStorage.getItem('unoPlayerId'))
    expect(noId).toBeNull()

    // B adds AI and starts game
    await pageB.click('#invite-ai')
    await pageB.waitForFunction(() => document.querySelectorAll('#players li').length === 2)
    await pageB.click('#ready')
    // AI is ready by default, game should start
    await pageB.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // Wait a bit — A should NOT see any lobby or game updates
    await pageA.waitForTimeout(1500)

    // A should still be at join form, not showing lobby/players
    const aInJoinForm = await pageA.evaluate(() => {
      const join = document.getElementById('join')
      const players = document.querySelectorAll('#players li')
      const lobby = document.getElementById('lobby')
      return join && !join.disabled && players.length === 0 && lobby && lobby.style.display !== 'none'
    })
    expect(aInJoinForm).toBe(true)

    await pageA.close()
    await pageB.close()
  })

  // TODO: fix game start race condition with 3+ players / AI
  it('3-player room: surrender removes player, game continues', { timeout: 45000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    const pageC = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)
    await pageC.goto(BASE)

    const lobbyId = 'surr-' + Date.now()
    // A creates room
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    // B joins
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)
    // C joins
    await pageC.fill('#name', 'Charlie')
    await pageC.fill('#lobby-id', lobbyId)
    await pageC.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 3)
    await pageB.waitForFunction(() => document.querySelectorAll('#players li').length === 3)
    await pageC.waitForFunction(() => document.querySelectorAll('#players li').length === 3)

    // Everyone ready → start game
    await pageA.click('#ready')
    await pageA.waitForTimeout(300)
    await pageB.click('#ready')
    await pageB.waitForTimeout(300)
    await pageC.click('#ready')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })
    await pageB.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })
    await pageC.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // A surrenders
    await pageA.click('#surrender-btn')
    // Confirm "确定要认输吗？"
    await pageA.waitForSelector('#modal-ok-btn', { timeout: 5000 })
    await pageA.click('#modal-ok-btn')
    // Wait for server to send surrender_offer → client shows spectate confirm
    await pageA.waitForSelector('#modal-cancel-btn', { timeout: 10000 })
    await pageA.click('#modal-cancel-btn')

    // A should return to lobby view
    await pageA.waitForFunction(() => {
      const el = document.getElementById('lobby')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // B and C should still be in game (game continues)
    await pageB.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 5000 })
    await pageC.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 5000 })

    // Verify B and C see only 2 players in turn order
    const bPlayerCount = await pageB.evaluate(() => {
      const pills = document.querySelectorAll('.turn-order-pill')
      return pills.length
    })
    expect(bPlayerCount).toBe(2)

    await pageA.close()
    await pageB.close()
    await pageC.close()
  })

  it('3 tabs join same lobby and see each other', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    const pageC = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)
    await pageC.goto(BASE)

    const lobbyId = 'multi-' + Date.now()
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')

    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)
    await pageB.waitForFunction(() => document.querySelectorAll('#players li').length === 2)

    await pageC.fill('#name', 'Charlie')
    await pageC.fill('#lobby-id', lobbyId)
    await pageC.click('#join')

    // All 3 should see 3 players
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 3)
    await pageB.waitForFunction(() => document.querySelectorAll('#players li').length === 3)
    await pageC.waitForFunction(() => document.querySelectorAll('#players li').length === 3)

    // Verify player names (creator shows 👑 after name)
    const namesA = await pageA.$$eval('#players li .player-name', els => els.map(el => el.textContent))
    const namesB = await pageB.$$eval('#players li .player-name', els => els.map(el => el.textContent))
    const namesC = await pageC.$$eval('#players li .player-name', els => els.map(el => el.textContent))
    expect(namesA.some(n => n.includes('Alice'))).toBe(true)
    expect(namesA.some(n => n.includes('Bob'))).toBe(true)
    expect(namesA.some(n => n.includes('Charlie'))).toBe(true)
    expect(namesB.some(n => n.includes('Alice'))).toBe(true)
    expect(namesB.some(n => n.includes('Bob'))).toBe(true)
    expect(namesB.some(n => n.includes('Charlie'))).toBe(true)
    expect(namesC.some(n => n.includes('Alice'))).toBe(true)
    expect(namesC.some(n => n.includes('Bob'))).toBe(true)
    expect(namesC.some(n => n.includes('Charlie'))).toBe(true)

    // Creator (Alice) should see invite AI and ready buttons
    const readyVisible = await pageA.evaluate(() => document.getElementById('ready').style.display !== 'none')
    expect(readyVisible).toBe(true)

    await pageA.close()
    await pageB.close()
    await pageC.close()
  })

  it('spectator mode: join started lobby, watch game', { timeout: 45000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'spec-' + Date.now()
    // A creates room, adds AI, starts game
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    await pageA.click('#invite-ai')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)

    await pageA.click('#ready')
    // AI is already ready, wait for game start
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // Now B tries to join the started lobby
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    // Spectate offer appears
    await pageB.waitForSelector('#modal-ok-btn', { timeout: 5000 })
    // Click OK to spectate
    await pageB.click('#modal-ok-btn')

    // B should enter spectator mode — game view but no actions
    await pageB.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // B should be spectator — body has .spectator class
    const isSpectator = await pageB.evaluate(() => document.body.classList.contains('spectator'))
    expect(isSpectator).toBe(true)

    // B should see discard pile and turn order
    const discardVisible = await pageB.evaluate(() => {
      const el = document.getElementById('discard-pile')
      return el && el.children.length > 0
    })
    expect(discardVisible).toBe(true)

    // B should see turn order
    const orderText = await pageB.evaluate(() => {
      const el = document.getElementById('turn-order')
      return el ? el.textContent : ''
    })
    expect(orderText).toBeTruthy()

    // B's hand should be empty (spectator has no cards)
    const handCards = await pageB.$$('#player-hand .card')
    expect(handCards.length).toBe(0)

    await pageA.close()
    await pageB.close()
  })
})
