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

    // Alice clicks ready >> should show (已准备)
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

    // Alice clicks ready again >> should toggle to NOT ready
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

  it('full flow: B disconnects >> A readies (stays ready) >> B reconnects >> B readies >> game starts', { timeout: 45000 }, async () => {
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

    // 7. B clicks ready >> game starts
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

    // A draws >> gets 1 card (normal draw, < 100 cards)
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
    //     A already has 7 cards >> total 7 + 93 = 100. Deck=0, Discard=2
    await pageA.evaluate(() => { sendMessage({ action: 'dev_add_all_cards' }); })
    await pageA.waitForTimeout(500)

    const aBeforeDraw = await getCardCount(pageA)
    expect(aBeforeDraw).toBeGreaterThanOrEqual(100)

    // Step 3: A clicks draw >> should skip (>= MAX_HAND_CARDS), hand stays same, turn passes to B
    await pageA.click('#draw-card')
    await pageA.waitForTimeout(800)
    await pageB.waitForFunction(() => {
      const el = document.getElementById('turn-indicator');
      return el ? el.classList.contains('my-turn') : false;
    }, { timeout: 10000 })
    const aAfterSkip = await getCardCount(pageA)
    expect(aAfterSkip).toBe(aBeforeDraw)

    // Step 4: B draws >> discard has 2 cards >> reshuffle gives B a card
    const bBeforeDraw = await getCardCount(pageB)
    await pageB.click('#draw-card')
    await pageB.waitForTimeout(500)
    await pageA.waitForFunction(() => {
      const el = document.getElementById('turn-indicator');
      return el ? el.classList.contains('my-turn') : false;
    }, { timeout: 10000 })
    const bAfterDraw = await getCardCount(pageB)
    expect(bAfterDraw).toBeGreaterThan(bBeforeDraw)

    // Step 5: A removes 1 card (simulates playing a card) >> A < 100
    await pageA.evaluate(() => { sendMessage({ action: 'dev_remove_cards', count: 1 }); })
    await pageA.waitForTimeout(500)
    const aBeforeDraw2 = await getCardCount(pageA)
    expect(aBeforeDraw2).toBeLessThan(100)

    // Step 6: A clicks draw >> should now get +1 card
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
    // store.set writes to sessionStorage (always) and to a slot-scoped
    // localStorage key (e.g. unoPlayerId-1). It no longer writes the plain
    // localStorage key, so read sessionStorage here.
    const bobId = await pageB.evaluate(() => sessionStorage.getItem('unoPlayerId'))
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
    const name1 = await page.evaluate(() => sessionStorage.getItem('unoPlayerName') || localStorage.getItem('unoPlayerName'))
    expect(name1).toBe('TestPlayer')

    await page.fill('#lobby-id', 'TestLobby')
    const lobby1 = await page.evaluate(() => sessionStorage.getItem('unoLobbyId') || localStorage.getItem('unoLobbyId'))
    expect(lobby1).toBe('TESTLOBBY') // uppercased by input listener

    // Change and verify
    await page.fill('#name', 'Player2')
    const name2 = await page.evaluate(() => sessionStorage.getItem('unoPlayerName') || localStorage.getItem('unoPlayerName'))
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

    await pageA.waitForTimeout(300)

    // Verify A's storage reflects left state
    const leftFlag = await pageA.evaluate(() => store.get('unoLeftLobby'))
    expect(leftFlag).toBe('true')
    const noId = await pageA.evaluate(() => store.get('unoPlayerId'))
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

    // Everyone ready >> start game
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
    // Wait for server to send surrender_offer >> client shows spectate confirm
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

  it('non-matching cards have no hover lift, matching cards do', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    await pageA.goto(BASE)
    await pageA.waitForSelector('#name')

    const lobbyId = 'hover-' + Date.now()
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')

    // Invite AI and start game (AI is always ready)
    await pageA.click('#invite-ai')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)
    await pageA.click('#ready')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // Get discard pile top card info
    const topInfo = await pageA.evaluate(() => {
      const card = document.querySelector('#discard-pile .card')
      return {
        color: card ? card.getAttribute('data-color') : null,
        type: card ? card.getAttribute('data-type') : null
      }
    })
    expect(topInfo.color).toBeTruthy()
    expect(topInfo.type).toBeTruthy()

    // All cards in hand should have proper playable/non-playable marking
    const result = await pageA.evaluate((top) => {
      const cards = document.querySelectorAll('#player-hand .card')
      let matchingCount = 0
      let nonMatchingCount = 0
      let wildCount = 0
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i]
        const cColor = c.getAttribute('data-color')
        const cType = c.getAttribute('data-type')
        const isWild = cType === 'wild' || cType === 'wild4'
        const matches = isWild || cColor === top.color || cType === top.type
        const hasNotPlayable = c.classList.contains('not-playable')

        if (isWild) {
          wildCount++
          if (hasNotPlayable) return { error: 'wild card should not be not-playable' }
        } else if (matches) {
          matchingCount++
          if (hasNotPlayable) return { error: 'matching card should not be not-playable' }
        } else {
          nonMatchingCount++
          if (!hasNotPlayable) return { error: 'non-matching card should be not-playable' }
        }
      }
      return { matchingCount, nonMatchingCount, wildCount }
    }, topInfo)

    expect(result.error).toBeUndefined()
    expect(result.nonMatchingCount).toBeGreaterThan(0)

    await pageA.close()
  })

  it('invite AI button shows after leaving and re-creating lobby', { timeout: 30000 }, async () => {
    const page = await browser.newPage()
    await page.goto(BASE)
    await page.waitForSelector('#name')

    // Create first lobby
    await page.fill('#name', 'Alice')
    await page.fill('#lobby-id', 'firstLobby')
    await page.click('#join')
    await page.waitForSelector('#players li')

    // Verify invite AI button is visible (Alice is creator)
    const btn1 = await page.evaluate(() => {
      const btn = document.getElementById('invite-ai')
      return btn ? btn.style.display !== 'none' : false
    })
    expect(btn1).toBe(true)

    // Leave the lobby
    await page.click('#leave-lobby')
    await page.waitForSelector('#modal-ok-btn', { timeout: 3000 })
    await page.click('#modal-ok-btn')

    // Wait for join form
    await page.waitForFunction(() => {
      const el = document.getElementById('join')
      return el && !el.disabled
    }, { timeout: 5000 })

    // Create second lobby
    await page.fill('#name', 'Alice')
    await page.fill('#lobby-id', 'secondLobby')
    await page.click('#join')
    await page.waitForSelector('#players li')

    // Verify invite AI button is STILL visible (Alice is creator again)
    const btn2 = await page.evaluate(() => {
      const btn = document.getElementById('invite-ai')
      return btn ? btn.style.display !== 'none' : false
    })
    expect(btn2).toBe(true)

    await page.close()
  })

  it('drawing chain confirm dialog shows when breaking chain', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'chain-' + Date.now()
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
    await pageB.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // A plays draw2 (use dev to give a draw2, or send directly matching discard)
    const topInfo = await pageA.evaluate(() => {
      const card = document.querySelector('#discard-pile .card')
      return { color: card ? card.getAttribute('data-color') : 'red' }
    })

    // Make sure it is A's turn
    const isMyTurn = async (page) => await page.evaluate(() => {
      const el = document.getElementById('turn-indicator')
      return el ? el.classList.contains('my-turn') : false
    })
    if (!(await isMyTurn(pageA))) {
      await pageB.waitForFunction(() => {
        const el = document.getElementById('turn-indicator')
        return el ? el.classList.contains('my-turn') : false
      }, { timeout: 5000 })
      await pageB.click('#draw-card')
      await pageA.waitForTimeout(500)
    }

    // A plays draw2
    await pageA.evaluate((color) => {
      sendMessage({ action: 'play', card: { color: color, type: 'draw2' } })
    }, topInfo.color)
    await pageA.waitForTimeout(500)

    // Now B's turn — B clicks a card that is NOT draw2/wild4
    // Confirm dialog should appear
    await pageB.evaluate(() => {
      const cards = document.querySelectorAll('#player-hand .card')
      for (let i = 0; i < cards.length; i++) {
        const type = cards[i].getAttribute('data-type')
        if (type !== 'draw2' && type !== 'wild4') {
          cards[i].dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return
        }
      }
    })
    await pageB.waitForTimeout(300)

    // Confirm dialog should be visible with drawing count
    const modalVisible = await pageB.evaluate(() => {
      const overlay = document.getElementById('modal-overlay')
      return overlay && !overlay.classList.contains('hidden')
    })
    expect(modalVisible).toBe(true)
    const modalMsg = await pageB.$eval('#modal-message', el => el.textContent)
    expect(modalMsg).toContain('打破链式加牌')
    expect(modalMsg).toContain('张牌')

    // Click cancel on the modal to dismiss it
    await pageB.click('#modal-cancel-btn')
    await pageB.waitForTimeout(300)

    // Now click draw — confirm dialog should appear with penalty info
    await pageB.click('#draw-card')
    await pageB.waitForTimeout(300)
    const drawModalVisible = await pageB.evaluate(() => {
      const overlay = document.getElementById('modal-overlay')
      return overlay && !overlay.classList.contains('hidden')
    })
    expect(drawModalVisible).toBe(true)
    const drawModalMsg = await pageB.$eval('#modal-message', el => el.textContent)
    expect(drawModalMsg).toContain('打破链式加牌')
    expect(drawModalMsg).toContain('张牌')

    await pageA.close()
    await pageB.close()
  })

  it('draw in drawing state accepts penalty and adds cards', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'penalty-' + Date.now()
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
    await pageB.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    const isMyTurn = async (page) => await page.evaluate(() => {
      const el = document.getElementById('turn-indicator')
      return el ? el.classList.contains('my-turn') : false
    })
    const getCardCount = async (page) => (await page.$$('#player-hand .card')).length

    // Make sure it is A's turn
    if (!(await isMyTurn(pageA))) {
      await pageB.waitForFunction(() => {
        const el = document.getElementById('turn-indicator')
        return el ? el.classList.contains('my-turn') : false
      }, { timeout: 5000 })
      await pageB.click('#draw-card')
      await pageA.waitForTimeout(500)
    }

    // A plays draw2 using matching color
    const topColor = await pageA.evaluate(() => {
      const card = document.querySelector('#discard-pile .card')
      return card ? card.getAttribute('data-color') : 'red'
    })
    await pageA.evaluate((color) => {
      sendMessage({ action: 'play', card: { color: color, type: 'draw2' } })
    }, topColor)
    await pageA.waitForTimeout(500)

    // B now in drawing state — click draw and accept penalty
    const bBefore = await getCardCount(pageB)

    await pageB.click('#draw-card')
    await pageB.waitForSelector('#modal-ok-btn', { timeout: 3000 })
    await pageB.click('#modal-ok-btn') // accept penalty
    await pageB.waitForTimeout(500)

    // B should have 2 more cards
    const bAfter = await getCardCount(pageB)
    expect(bAfter).toBe(bBefore + 2)

    // State should be reset — B should be able to play normally now
    // (turn advanced after penalty, so it is A's turn)
    await pageA.waitForFunction(() => {
      const el = document.getElementById('turn-indicator')
      return el ? el.classList.contains('my-turn') : false
    }, { timeout: 5000 })

    await pageA.close()
    await pageB.close()
  })

  it('spectator can exit without error', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'specexit-' + Date.now()
    // A creates room, adds AI, starts game
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    await pageA.click('#invite-ai')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)
    await pageA.click('#ready')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // B joins as spectator
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    await pageB.waitForSelector('#modal-ok-btn', { timeout: 5000 })
    await pageB.click('#modal-ok-btn') // accept spectate
    await pageB.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // Verify B can see the leave button
    const btnVisible = await pageB.evaluate(() => {
      const btn = document.getElementById('leave-spectate-btn')
      return btn && btn.style.display !== 'none'
    })
    expect(btnVisible).toBe(true)

    // Click leave-spectate
    await pageB.click('#leave-spectate-btn')
    await pageB.waitForSelector('#modal-ok-btn', { timeout: 3000 })
    await pageB.click('#modal-ok-btn') // confirm

    // B should return to join form without error overlay
    await pageB.waitForFunction(() => {
      const el = document.getElementById('join')
      return el && !el.disabled
    }, { timeout: 10000 })

    await pageA.close()
    await pageB.close()
  })

  it('two tabs have isolated sessions', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    await pageA.goto(BASE)
    await pageA.waitForSelector('#name')
    await pageA.fill('#name', 'Alice')
    await pageA.waitForTimeout(500)

    // Tab B opens — should NOT share session (sessionStorage is per-tab)
    const pageB = await browser.newPage()
    await pageB.goto(BASE)
    await pageB.waitForSelector('#name')
    await pageB.waitForTimeout(500)

    // Tab A's name in sessionStorage
    const nameA = await pageA.evaluate(() => sessionStorage.getItem('unoPlayerName'))
    expect(nameA).toBe('Alice')

    // Tab B's sessionStorage should NOT have A's name
    const nameB = await pageB.evaluate(() => sessionStorage.getItem('unoPlayerName'))
    expect(nameB).toBeNull()

    await pageA.close()
    await pageB.close()
  })

  it('new tab does not auto-join previous tab lobby', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    await pageA.goto(BASE)
    await pageA.waitForSelector('#name')
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', 'ALPHA')
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    await pageA.waitForTimeout(300)

    // Open tab B — should NOT auto-join
    const pageB = await browser.newPage()
    await pageB.goto(BASE)
    await pageB.waitForSelector('#name')
    await pageB.waitForTimeout(500)

    // Tab B should be at join form with no players
    const inLobby = await pageB.evaluate(() => {
      const joinBtn = document.getElementById('join')
      const players = document.querySelectorAll('#players li')
      return joinBtn && !joinBtn.disabled && players.length === 0
    })
    expect(inLobby).toBe(true)

    await pageA.close()
    await pageB.close()
  })

  it('surrender with 2 humans + AI does not end game', { timeout: 45000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    const lobbyId = 'surrpl-' + Date.now()
    // A creates room
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    // Add AI
    await pageA.click('#invite-ai')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)
    // B joins
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 3)

    // All ready — game starts
    await pageA.click('#ready') // Alice ready
    await pageB.click('#ready') // Bob ready, AI already ready
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })
    await pageB.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // A surrenders
    await pageA.click('#surrender-btn')
    await pageA.waitForSelector('#modal-ok-btn', { timeout: 3000 })
    await pageA.click('#modal-ok-btn') // confirm surrender
    // Spectate offer appears — click Cancel to leave
    await pageA.waitForSelector('#modal-cancel-btn', { timeout: 3000 })
    await pageA.click('#modal-cancel-btn')

    // A should return to lobby
    await pageA.waitForFunction(() => {
      const el = document.getElementById('lobby')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // B should still be in game (game continues with Bob vs AI)
    await pageB.waitForTimeout(1500)
    const bInGame = await pageB.evaluate(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    })
    expect(bInGame).toBe(true)

    // Turn order should show 2 players (Bob + AI)
    const playerCount = await pageB.evaluate(() => {
      const pills = document.querySelectorAll('.turn-order-pill')
      return pills.length
    })
    expect(playerCount).toBe(2)

    await pageA.close()
    await pageB.close()
  })

  it('joining AI-only lobby does not show spectate offer', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    await pageA.goto(BASE)
    await pageA.waitForSelector('#name')

    const lobbyId = 'aionly-' + Date.now()
    // A creates room, adds AI, starts game
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', lobbyId)
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')
    await pageA.click('#invite-ai')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)
    await pageA.click('#ready')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // A surrenders — AI wins
    await pageA.click('#surrender-btn')
    await pageA.waitForSelector('#modal-ok-btn', { timeout: 3000 })
    await pageA.click('#modal-ok-btn')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('game-over-overlay')
      return el && !el.classList.contains('hidden')
    }, { timeout: 5000 })

    // Dismiss game-over overlay
    await pageA.click('#game-over-btn')
    await pageA.waitForFunction(() => {
      const el = document.getElementById('join')
      return el && !el.disabled
    }, { timeout: 5000 })

    // B tries to join same lobby — should create fresh, no spectate offer
    const pageB = await browser.newPage()
    await pageB.goto(BASE)
    await pageB.waitForSelector('#name')
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', lobbyId)
    await pageB.click('#join')

    // B should see players list (joined fresh lobby), NOT spectate dialog
    await pageB.waitForSelector('#players li', { timeout: 5000 })
    const bHasPlayers = await pageB.evaluate(() => document.querySelectorAll('#players li').length > 0)
    expect(bHasPlayers).toBe(true)

    // Verify no spectate dialog appeared
    const spectateShown = await pageB.evaluate(() => {
      const overlay = document.getElementById('modal-overlay')
      return overlay && !overlay.classList.contains('hidden')
    })
    expect(spectateShown).toBe(false)

    await pageA.close()
    await pageB.close()
  })

  it('wild color picker scrolls into view when shown', { timeout: 30000 }, async () => {
    const page = await browser.newPage()
    await page.goto(BASE)
    await page.waitForSelector('#name')

    // Create lobby with AI and start game
    await page.fill('#name', 'Test')
    await page.fill('#lobby-id', 'wildscroll')
    await page.click('#join')
    await page.waitForSelector('#players li')
    await page.click('#invite-ai')
    await page.waitForFunction(() => document.querySelectorAll('#players li').length === 2)
    await page.click('#ready')
    await page.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // Scroll to bottom so the picker would be off-screen
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(300)

    // Find and click a wild card
    const clickedWild = await page.evaluate(() => {
      const cards = document.querySelectorAll('#player-hand .card')
      for (let i = 0; i < cards.length; i++) {
        const type = cards[i].getAttribute('data-type')
        if (type === 'wild' || type === 'wild4') {
          cards[i].dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return true
        }
      }
      return false
    })

    if (clickedWild) {
      await page.waitForTimeout(500)
      // Color picker should be visible and in viewport
      const inView = await page.evaluate(() => {
        const picker = document.getElementById('wild-color-picker')
        if (!picker || picker.style.display === 'none') return false
        const rect = picker.getBoundingClientRect()
        return rect.top >= -50 && rect.bottom <= window.innerHeight + 50
      })
      expect(inView).toBe(true)
    }

    await page.close()
  })

  it('wild color picker scrolls back on cancel, not on manual scroll', { timeout: 30000 }, async () => {
    const page = await browser.newPage()
    await page.goto(BASE)
    await page.waitForSelector('#name')

    await page.fill('#name', 'Test')
    await page.fill('#lobby-id', 'wcancel')
    await page.click('#join')
    await page.waitForSelector('#players li')
    await page.click('#invite-ai')
    await page.waitForFunction(() => document.querySelectorAll('#players li').length === 2)
    await page.click('#ready')
    await page.waitForFunction(() => {
      const el = document.getElementById('game')
      return el && el.style.display !== 'none'
    }, { timeout: 10000 })

    // Record initial scroll position
    const initialY = await page.evaluate(() => window.scrollY)

    // Find and click a wild card
    const found = await page.evaluate(() => {
      const cards = document.querySelectorAll('#player-hand .card')
      for (let i = 0; i < cards.length; i++) {
        if (cards[i].getAttribute('data-type') === 'wild' || cards[i].getAttribute('data-type') === 'wild4') {
          cards[i].dispatchEvent(new MouseEvent('click', { bubbles: true }))
          return true
        }
      }
      return false
    })

    if (found) {
      await page.waitForTimeout(800) // wait for smooth scroll
      const afterShowY = await page.evaluate(() => window.scrollY)
      // Picker should have scrolled to it — position changed from initial
      expect(Math.abs(afterShowY - initialY)).toBeGreaterThan(50)

      // Manually scroll somewhere else
      await page.evaluate(() => window.scrollTo(0, 500))
      await page.waitForTimeout(300)

      // Click cancel — should NOT scroll back because user scrolled manually
      await page.click('#cancel-wild-btn')
      await page.waitForTimeout(500)
      const afterCancelY = await page.evaluate(() => window.scrollY)
      // Should be near 500 (manual scroll pos), not back to initial
      expect(Math.abs(afterCancelY - 500)).toBeLessThan(200)
    }

    await page.close()
  })

  it('draw mode toggle visible to creator, not to others', { timeout: 30000 }, async () => {
    const pageA = await browser.newPage()
    const pageB = await browser.newPage()
    await pageA.goto(BASE)
    await pageB.goto(BASE)

    // A creates room
    await pageA.fill('#name', 'Alice')
    await pageA.fill('#lobby-id', 'dmode')
    await pageA.click('#join')
    await pageA.waitForSelector('#players li')

    // A should see the toggle (is creator)
    const aSees = await pageA.evaluate(() => {
      const el = document.getElementById('draw-mode-area')
      return el ? el.style.display !== 'none' : false
    })
    expect(aSees).toBe(true)

    // Info title should describe both modes
    const infoTitle = await pageA.$eval('#draw-mode-info', el => el.title)
    expect(infoTitle).toContain('链式')

    // Click info — should open rules modal
    await pageA.click('#draw-mode-info')
    await pageA.waitForTimeout(500)
    const rulesVisible = await pageA.evaluate(() => {
      const el = document.getElementById('rules-overlay')
      return el && !el.classList.contains('hidden')
    })
    expect(rulesVisible).toBe(true)
    // Close rules modal
    await pageA.click('#rules-close-btn')
    await pageA.waitForTimeout(300)

    // B joins
    await pageB.fill('#name', 'Bob')
    await pageB.fill('#lobby-id', 'dmode')
    await pageB.click('#join')
    await pageA.waitForFunction(() => document.querySelectorAll('#players li').length === 2)

    // B should NOT see the toggle
    const bSees = await pageB.evaluate(() => {
      const el = document.getElementById('draw-mode-area')
      return el ? el.style.display !== 'none' : false
    })
    expect(bSees).toBe(false)

    // A clicks "直接加牌" option
    await pageA.evaluate(() => {
      document.querySelector('.mode-left').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await pageA.waitForTimeout(300)
    const directActive = await pageA.evaluate(() => document.querySelector('.mode-left').classList.contains('active'))
    expect(directActive).toBe(true)

    await pageA.close()
    await pageB.close()
  })

  // Regression: three tabs sharing localStorage should each restore their own
  // saved name after a full close-reopen cycle. Previously store.set wrote a
  // shared plain key on every keystroke, so the last writer ("33") clobbered
  // the others, and on reopen the slot election (~250 ms) had not finished
  // yet, so onopen fell back to that shared key — every tab showed "33".
  it('three tabs each restore their own name after close-reopen', { timeout: 30000 }, async () => {
    // newPage() on a Browser creates a fresh BrowserContext per page, which
    // gives each "tab" its own isolated localStorage — the opposite of what
    // real browser tabs do, and would mask the bug. Use a single shared
    // context so all three pages share storage like real tabs.
    const ctx = await browser.newContext()
    const NAMES = ['11', '22', '33']

    async function openTab() {
      const p = await ctx.newPage()
      await p.goto(BASE)
      await p.waitForSelector('#name')
      // Wait past the slot election window (~250 ms) plus a little slack.
      await p.waitForFunction(() => Number(sessionStorage.getItem('unoSlot')) > 0, { timeout: 5000 })
      return p
    }

    // Round 1: open three tabs, fill different names.
    const round1 = []
    for (let i = 0; i < 3; i++) {
      const p = await openTab()
      await p.fill('#name', NAMES[i])
      // Blur so the input handler that calls store.set finishes synchronously.
      await p.locator('#name').press('Tab')
      round1.push(p)
    }

    // Sanity: while all tabs are open, none should have lost its own value.
    for (let i = 0; i < 3; i++) {
      const v = await round1[i].locator('#name').inputValue()
      expect(v).toBe(NAMES[i])
    }

    // Close all three tabs and let the bye/prune logic settle.
    for (const p of round1) await p.close()
    await new Promise(r => setTimeout(r, 300))

    // Round 2: reopen three tabs. Each should restore one of the saved names,
    // and collectively they must cover {11, 22, 33} with no duplicates.
    const round2 = []
    for (let i = 0; i < 3; i++) round2.push(await openTab())

    const restored = []
    for (const p of round2) restored.push(await p.locator('#name').inputValue())

    expect([...restored].sort()).toEqual([...NAMES].sort())
    expect(new Set(restored).size).toBe(3)

    for (const p of round2) await p.close()
    await ctx.close()
  })
})
