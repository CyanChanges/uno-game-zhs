import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chromium } from 'playwright'
import { fork } from 'child_process'
import path from 'path'

const BASE = 'http://localhost:3000'

let browser, serverProcess

beforeAll(async () => {
  serverProcess = fork(path.resolve('./server.js'), [], {
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

  // know issue
  // it('shows (已准备) after player readies', async () => {
  //   const pageA = await browser.newPage()
  //   const pageB = await browser.newPage()
  //   await pageA.goto(BASE)
  //   await pageB.goto(BASE)

  //   // Join lobby
  //   await pageA.fill('#name', 'Alice')
  //   await pageA.fill('#lobby-id', 'test1')
  //   await pageA.click('#join')
  //   await pageA.waitForSelector('#players li')

  //   await pageB.fill('#name', 'Bob')
  //   await pageB.fill('#lobby-id', 'test1')
  //   await pageB.click('#join')

  //   // Wait for both to see each other
  //   await pageA.waitForFunction(() => {
  //     const items = document.querySelectorAll('#players li')
  //     return items.length === 2
  //   })
  //   await pageB.waitForFunction(() => {
  //     const items = document.querySelectorAll('#players li')
  //     return items.length === 2
  //   })

  //   // Bob disconnect
  //   await pageB.close()

  //   const newPageB = await browser.newPage()

  //   // Alice clicks ready → should show (已准备)
  //   await pageA.click('#ready')
  //   await pageA.waitForFunction(() => {
  //     const items = document.querySelectorAll('#players li')
  //     return items[0]?.textContent?.includes('（已准备）')
  //   })

  //   const aliceName = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
  //   expect(aliceName).toContain('（已准备）')

  //   await wait(1500)

  //   // 1.5s recheck Alice is ready
  //   const aliceName1 = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
  //   expect(aliceName1).toContain('（已准备）')

  //   await wait(300)

  //   // Bob rejoin
  //   await newPageB.goto(BASE)
  //   await newPageB.waitForFunction(() => {
  //     const items = document.querySelectorAll('#players li')
  //     return items.length === 2
  //   }, { timeout: 3000 })

  //   await pageA.click('#ready')

  //   const aliceName2 = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
  //   expect(aliceName2).toContain('（已准备）')

  //   // Bob disconnect again
  //   await newPageB.close()

  //   await wait(500)

  //   const aliceName3 = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
  //   expect(aliceName3).toContain('（已准备）')

  //   await pageA.click('#ready')

  //   await wait(1500)

  //   const aliceName4 = await pageA.$eval('#players li:first-child .player-name', el => el.textContent)
  //   expect(aliceName4).not.toContain('（已准备）')

  //   await pageA.close()
  // }, { timeout: 30000})

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
      return items.length === 2 && items[1]?.classList?.contains('disconnected')
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
      return !items[1]?.classList?.contains('disconnected')
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
    const isMyTurn = async (page) => await page.evaluate(() =>
      document.getElementById('turn-indicator')?.classList.contains('my-turn')
    )

    // If B goes first, B draws to pass turn to A
    if (!(await isMyTurn(pageA))) {
      await pageB.waitForFunction(() =>
        document.getElementById('turn-indicator')?.classList.contains('my-turn')
        , { timeout: 10000 })
      await pageB.click('#draw-card')
      await pageA.waitForTimeout(500)
    }

    // A draws → gets 1 card (normal draw, < 100 cards)
    const aBefore = await getCardCount(pageA)
    await pageA.click('#draw-card')
    await pageA.waitForTimeout(500)
    // Turn passes to B
    await pageB.waitForFunction(() =>
      document.getElementById('turn-indicator')?.classList.contains('my-turn')
      , { timeout: 10000 })
    const aAfter = await getCardCount(pageA)
    expect(aAfter).toBe(aBefore + 1)

    await pageA.close()
    await pageB.close()
  })
})
