/**
 * Turn the recorded demo into a short looping GIF for the README.
 *
 * The host has no ffmpeg delegate, so decoding happens in Chrome: the video is
 * seeked frame by frame, drawn to a canvas, and saved as PNG. ImageMagick then
 * assembles the GIF. This is a media tool, not part of the plugin runtime.
 *
 * Usage:
 *   node bench/make-gif.mjs --stills 3,8,13,18          # inspect moments
 *   node bench/make-gif.mjs --start 7.5 --end 17.5 --fps 8 --width 800
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const harness = process.env.DSH_HARNESS ?? '/Users/zhinan/deepseek-harness'
const require = createRequire(`${harness}/apps/web/package.json`)
const { chromium } = require('playwright')

const args = process.argv.slice(2)
function option(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const source = resolve(repo, process.env.GIF_SOURCE ?? 'media/dsh-langgraph-demo.webm')
const out = resolve(repo, option('out', 'media/dsh-langgraph-demo.gif'))
const width = Number(option('width', 800))
const fps = Number(option('fps', 8))
const stills = option('stills', '')

const contentTypes = { '.webm': 'video/webm', '.png': 'image/png', '.html': 'text/html', '.json': 'application/json' }

/** A tiny static server, so the canvas is same-origin with the video. */
async function serve() {
  const server = createServer(async (request, response) => {
    const path = resolve(repo, decodeURIComponent(request.url.split('?')[0]).replace(/^\/+/, ''))
    if (!path.startsWith(repo)) {
      response.writeHead(403).end()
      return
    }
    if (path === resolve(repo, '__page')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end('<!doctype html><meta charset="utf-8"><title>frame</title><body></body>')
      return
    }
    let size
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new Error('not a file')
      size = info.size
    } catch {
      response.writeHead(404).end()
      return
    }
    const type = contentTypes[path.slice(path.lastIndexOf('.'))] ?? 'application/octet-stream'
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '')
    if (range === null) {
      response.writeHead(200, {
        'content-type': type,
        'content-length': size,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      })
      createReadStream(path).pipe(response)
      return
    }
    // Chrome seeks a media element with ranged requests; without 206 it would
    // only ever play from the start.
    const start = range[1] === '' ? 0 : Number(range[1])
    const end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)
    if (start > end) {
      response.writeHead(416, { 'content-range': `bytes */${size}` }).end()
      return
    }
    response.writeHead(206, {
      'content-type': type,
      'content-length': end - start + 1,
      'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    })
    createReadStream(path, { start, end }).pipe(response)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  return { server, port: server.address().port }
}

const { server, port } = await serve()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const workDir = await mkdtemp(join(tmpdir(), 'lg-gif-'))

try {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  await page.goto(`http://127.0.0.1:${port}/__page`)
  await page.evaluate(sourceUrl => {
    const video = document.createElement('video')
    video.src = sourceUrl
    video.muted = true
    video.preload = 'auto'
    document.body.style.margin = '0'
    document.body.style.background = '#05080d'
    document.body.append(video)
    const canvas = document.createElement('canvas')
    window.__frame = { video, canvas }
    return new Promise((done, fail) => {
      video.addEventListener('loadedmetadata', () => done({ duration: video.duration, width: video.videoWidth, height: video.videoHeight }), { once: true })
      video.addEventListener('error', () => fail(new Error('video failed to load')), { once: true })
    })
  }, `/media/${basename(source)}`)

  const meta = await page.evaluate(() => ({
    duration: window.__frame.video.duration,
    width: window.__frame.video.videoWidth,
    height: window.__frame.video.videoHeight,
  }))
  const height = Math.round((meta.height * width) / meta.width)
  page.setViewportSize({ width, height })
  console.log(JSON.stringify({ source, ...meta, width, height, duration: meta.duration }))

  async function grab(time) {
    const data = await page.evaluate(async ({ time, width, height }) => {
      const { video, canvas } = window.__frame
      await new Promise(done => {
        const handle = () => {
          video.removeEventListener('seeked', handle)
          done()
        }
        video.addEventListener('seeked', handle)
        video.currentTime = time
      })
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(video, 0, 0, width, height)
      return { png: canvas.toDataURL('image/png'), at: video.currentTime, readyState: video.readyState }
    }, { time, width, height })
    if (Math.abs(data.at - time) > 0.5) console.warn(`seek mismatch: wanted ${time}, at ${data.at}`)
    return Buffer.from(data.png.slice(data.png.indexOf(',') + 1), 'base64')
  }

  if (stills !== '') {
    const dir = join(workDir, 'stills')
    await mkdir(dir, { recursive: true })
    for (const time of stills.split(',').map(Number)) {
      const file = join(dir, `still-${time.toFixed(1)}.png`)
      await writeFile(file, await grab(time))
      console.log(file)
    }
  } else {
    const start = Number(option('start', 7.5))
    const end = Number(option('end', 17.5))
    const dir = join(workDir, 'frames')
    await mkdir(dir, { recursive: true })
    const count = Math.max(1, Math.round((end - start) * fps))
    for (let index = 0; index <= count; index += 1) {
      const time = Math.min(meta.duration, start + index / fps)
      const name = join(dir, `frame-${String(index).padStart(4, '0')}.png`)
      await writeFile(name, await grab(time))
      if (index % 10 === 0) console.log(`frame ${index}/${count} at ${time.toFixed(2)}s`)
    }
    const delay = Math.round(100 / fps)
    execFileSync('magick', [
      '-delay', String(delay),
      '-loop', '0',
      ...(await readdir(dir)).sort().map(name => join(dir, name)),
      '-colors', String(Number(option('colors', 128))),
      '+dither',
      '-layers', 'Optimize',
      out,
    ])
    await mkdir(dirname(out), { recursive: true })
    console.log(`wrote ${out}`)
  }
} finally {
  await browser.close().catch(() => {})
  server.close()
  if (process.env.GIF_KEEP !== '1') await rm(workDir, { recursive: true, force: true })
  else console.log(`kept ${workDir}`)
}
