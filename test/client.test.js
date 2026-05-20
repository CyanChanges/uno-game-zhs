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

  it('shows (已准备) after player readies and state persists after opponent disconnects', { timeout: 30000 }, async () => {
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
})
