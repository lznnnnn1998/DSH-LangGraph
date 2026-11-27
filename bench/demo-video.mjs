/**
 * Record a real DSH Web session as a short demo.
 *
 * Usage:
 *   DEMO_URL='http://localhost:3085/?token=…' \
 *   node bench/demo-video.mjs
 *
 * The session must already exist and be completed. This script is a recorder,
 * not a model run: it opens the real app, scrolls the transcript, opens the
 * trajectory and the LangGraph panel, and saves a .webm plus two screenshots.
 */
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const harness = process.env.DSH_HARNESS ?? '/Users/zhinan/deepseek-harness'
const require = createRequire(`${harness}/apps/web/package.json`)
const { chromium } = require('playwright')

const url = process.env.DEMO_URL
const sessionTitle = process.env.DEMO_SESSION ?? 'Build 12-topic brief with LangGraph'
const out = process.env.DEMO_OUT ?? resolve(repo, 'media/dsh-langgraph-demo.webm')
const sessionShot = process.env.DEMO_SHOT ?? resolve(repo, 'gallery/assets/session.png')
const galleryShot = resolve(repo, 'gallery/assets/gallery.png')
const videoDir = resolve(repo, 'media/raw')

if (!url) {
  console.error('DEMO_URL is required (the DSH Web token URL)')
  process.exit(2)
}
await mkdir(dirname(out), { recursive: true })
await mkdir(dirname(sessionShot), { recursive: true })
await mkdir(videoDir, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } },
})
const page = await context.newPage()
page.setDefaultTimeout(5000)
const video = page.video()
let scroller = null

const wait = ms => page.waitForTimeout(ms)
const caption = async text => {
  await page.evaluate(value => {
    let node = document.getElementById('__demo_caption')
    if (!node) {
      node = document.createElement('div')
      node.id = '__demo_caption'
      node.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
        'z-index:2147483647', 'pointer-events:none', 'padding:9px 16px',
        'border-radius:999px', 'background:rgba(8,12,20,.86)',
        'border:1px solid rgba(150,175,220,.28)', 'color:#e8edf7',
        'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace',
        'box-shadow:0 12px 40px rgba(0,0,0,.45)', 'backdrop-filter:blur(12px)',
        'white-space:nowrap', 'letter-spacing:.01em',
      ].join(';')
      document.body.append(node)
    }
    node.textContent = value
  }, text)
}

async function scrollTo(fraction) {
  await page.evaluate(value => {
    const el = window.__demoScroller
    if (!el) return
    el.scrollTo({ top: Math.max(0, el.scrollHeight * value - el.clientHeight * 0.5), behavior: 'smooth' })
  }, fraction)
  await wait(1300)
}

async function findScroller() {
  return page.evaluate(() => {
    const candidates = [...document.querySelectorAll('*')]
      .filter(el => el.scrollHeight - el.clientHeight > 200 && el.clientHeight > 300)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)
    if (candidates.length === 0) return null
    const el = candidates[0]
    window.__demoScroller = el
    el.scrollTo({ top: 0 })
    return { tag: el.tagName, cls: String(el.className).slice(0, 80), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await wait(2600)

  // The app may open a fresh New Session after a restart. Decide from the
  // session header, not from the whole body: the sidebar can contain the title
  // while the open transcript is still empty.
  const header = page.locator('nav[aria-label="Session hierarchy"], [aria-label="Session hierarchy"]').first()
  const headerText = await header.innerText().catch(() => '')
  if (!headerText.includes(sessionTitle)) {
    // A restart may open a New Session. Open the session tree/search, then
    // click the tree item by title. The search button can be hidden inside the
    // sidebar scroll, so invoke its DOM click rather than a coordinate click.
    await page.evaluate(() => document.querySelector('button[aria-label="Search sessions"]')?.click())
    await wait(900)
    let row = page.getByRole('treeitem').filter({ hasText: sessionTitle }).first()
    if (!(await row.count())) {
      const group = page.getByRole('treeitem', { name: 'Ungrouped', exact: true }).first()
      if (await group.count()) {
        await group.click()
        await wait(900)
      }
      row = page.getByRole('treeitem').filter({ hasText: sessionTitle }).first()
    }
    if (!(await row.count())) row = page.getByText(sessionTitle, { exact: false }).first()
    if (await row.count()) {
      await row.click()
      await wait(1800)
    }
  }

  scroller = await findScroller()
  await caption('A real DSH session · 12 files · a fine map graph · 166 tests')
  await wait(2800)

  // The prompt and the graph composition.
  await scrollTo(0.08)
  await caption('Read 12 topics, extract one row per file — a map of roles')
  await wait(2600)
  await scrollTo(0.28)
  await caption('Two 12-item maps, then a single outline model')
  await wait(2600)

  // The outline and the human gate.
  await scrollTo(0.45)
  await caption('The outline arrives; the graph pauses at a human gate')
  await page.screenshot({ path: sessionShot, fullPage: false }).catch(() => {})
  await wait(3000)
  await scrollTo(0.62)
  await caption('The thread is the ledger: approve, and the same run resumes')
  await wait(2600)

  // The answer and the final brief.
  await scrollTo(0.82)
  await caption('Resume with the raw answer · write_brief settles the file')
  await wait(2600)
  await scrollTo(1)
  await caption('12 correct rows · output on disk')
  await wait(2600)

  // The trace.
  const trajectory = page.getByRole('tab', { name: 'Trajectory' })
  if (await trajectory.count()) {
    await trajectory.first().click()
    await wait(1200)
    const traceScroller = await findScroller()
    await caption('Trajectory: every node, tool call and model call is visible')
    await wait(2600)
    if (traceScroller) await scrollTo(0.55)
    await wait(1800)
  }

  // Back to the chat and the final file.
  const chat = page.getByRole('tab', { name: 'Chat' })
  if (await chat.count()) {
    await chat.first().click()
    await wait(900)
    await scrollTo(1)
  }
  const fileButton = page.getByRole('button', { name: 'brief-fine.md' })
  if (await fileButton.count()) {
    await fileButton.first().click()
    await wait(1800)
    await caption('The output is a normal file; the graph was only the seam')
    await wait(2200)
    await page.keyboard.press('Escape').catch(() => {})
    await wait(700)
  }

  // The LangGraph panel.
  const panel = page.getByRole('button', { name: 'Open right sidebar' })
  if (await panel.count()) {
    await panel.first().click()
    await wait(1600)
    await caption('The LangGraph panel: registered graphs, threads, topology')
    await wait(2400)
  }

  // End card.
  await caption('dsh-langgraph · the graph is a contract, the compiler is a clerk')
  await wait(2200)

  // Gallery screenshot from the static page (no server needed).
  const gallery = await context.newPage()
  await gallery.goto(`file://${resolve(repo, 'gallery/index.html')}`, { waitUntil: 'load' })
  await gallery.waitForTimeout(1800)
  await gallery.screenshot({ path: galleryShot, fullPage: false }).catch(() => {})
  await gallery.close()

  await wait(800)
} finally {
  await page.close().catch(() => {})
  await video.saveAs(out).catch(error => console.error('video save failed:', error.message))
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  console.log(JSON.stringify({ video: out, sessionShot, galleryShot, scroller }, null, 2))
}
