// The goal row above the prompt: one line, always there, drawn the way usage-band draws its
// band so the two read as one family. Pure functions: no mods API calls, so tests drive them.
//
// Desktop and mobile get one SVG drawn as a plain image (an image redraws in place; a framed SVG
// blinks on every redraw), with usage-band's type, rounded bar and shine. The terminal gets one
// row of spans with usage-band's ■ bar.

import { minutes, clip } from './fmt.mjs'

// usage-band's hues are cyan, amber, indigo and green. The goal row stays plain so it never fights
// them: bright text and a light bar, green once done
export const HUE = { goal: '#d5d8dd', done: '#72cf9f' }
const TRACK = '#4a4f5c'
// The row draws 1:1, the same 13px as usage-band's band; the steps card uses the same type.
export const SCALE = 1
const scaled = (v) => Math.ceil(v * SCALE)

// Blend a #rrggbb color toward white (t > 0) or black (t < 0) by |t|
export const lighten = (hex, t) => {
  const n = parseInt(hex.slice(1), 16)
  const target = t >= 0 ? 255 : 0
  const ch = (v) => Math.round(v + (target - v) * Math.abs(t)).toString(16).padStart(2, '0')
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`
}

const esc = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---- what the row says, the same on every surface

/**
 * The row's parts, or null when there is nothing to say (a chat that has done no work yet).
 * - a plan running: its title, bar, done of total, ETA
 * - Claude on a turn with no plan running (`work`: the turn's tool calls so far): 'working'
 * - otherwise the latest thing finished, whichever ended last: the plan (done or stopped, however
 *   long ago) or the last turn's work with no plan (`last`: { calls, ms, at }). Never "idle":
 *   a row that just says nothing is going on tells the reader nothing.
 * state: 'working' | 'planning' | 'running' | 'done' | 'stopped' | 'last'
 */
// How long ago something finished, so an old 完成 is not read as a fresh one
export function ago(at, nowMs) {
  const s = Math.max(0, Math.round((nowMs - at) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  const d = new Date(at)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function rowOf(g, p, etaMs, work = null, last = null, nowMs = 0) {
  const when = (at) => (nowMs && at ? ` · ${ago(at, nowMs)}` : '')
  const running = g && g.status === 'running'
  if (!running && work) return { state: 'working', title: '工作中', detail: work.calls ? `${work.calls} 个操作` : '' }
  const planEnd = g && !running ? g.endedAt || g.updatedAt || 0 : 0
  if (!running && last && (!g || last.at > planEnd)) {
    return { state: 'last', title: '上一轮', figure: '完成 ✓', detail: `${last.calls} 个操作 · 用时 ${minutes(last.ms)}${when(last.at)}` }
  }
  if (!g) return null
  const title = clip(g.title, 48)
  // done: a full green bar; for its first seconds (`celebrate`) a shine sweeps it
  if (g.status === 'met') return { state: 'done', title, fraction: 1, celebrate: !!g.celebrate, figure: '完成 ✓', detail: `用时 ${minutes((g.endedAt || 0) - g.startedAt)}${when(g.endedAt)}` }
  if (g.status !== 'running') return { state: 'stopped', title, figure: '已停止', detail: when(g.endedAt).replace(/^ · /, '') }
  if (!g.planned && !g.planAt) return { state: 'planning', title, detail: '列步骤中…' }
  return {
    state: 'running',
    title,
    fraction: p.fraction,
    figure: `${p.doneN}/${p.n} · ${p.pct}%`,
    // no time left to estimate, but tasks of the plan still running in the background: say so
    detail: etaMs ? `剩约 ${minutes(etaMs)}` : g.background ? `后台 ${g.background} 个任务在跑` : '',
  }
}

export function describe(r) {
  return [r.state === 'working' || r.state === 'last' ? r.title : `任务：${r.title}`, r.figure, r.detail].filter(Boolean).join('，')
}

// ---- desktop: one SVG in usage-band's style

const CAP = { top: 9.75, h: 10 }
// barW is usage-band's own bar length
const D = { h: 30, inner: 7, size: 13, barW: 76, barH: 6, icon: 10 }
// Advance widths in em for Inter (SF Pro, the fallback, runs within a few %): measured classes,
// not one flat guess, so Latin text is not stretched apart; wide CJK and symbols take a full em
const NARROW = new Set([...'iljtf.,:;!|\'()[]/ '])
const WIDE = new Set([...'mwMW@%'])
export const textW = (v, size = D.size) =>
  [...v].reduce((w, c) => {
    if (c.codePointAt(0) >= 0x2e80) return w + 1
    if (c >= '0' && c <= '9') return w + 0.62
    if (c === ' ') return w + 0.26
    if (NARROW.has(c)) return w + 0.3
    if (WIDE.has(c)) return w + 0.86
    if (c === '·' || c === '~' || c === '<' || c === '>') return w + 0.55
    if (c === '✓') return w + 0.7
    if (c >= 'A' && c <= 'Z') return w + 0.66
    return w + 0.54
  }, 0) * size

const pinW = (v) => `textLength="${textW(v).toFixed(1)}" lengthAdjust="spacing"`
const ink = (hue, x, v) =>
  `<text x="${x}" y="19.5" font-size="${D.size}" ${pinW(v)} class="ink" style="--l:${lighten(hue, -0.38)};--d:${lighten(hue, 0.25)}">${esc(v)}</text>`
const mute = (x, v) => `<text x="${x}" y="19.5" font-size="${D.size}" ${pinW(v)} class="mute">${esc(v)}</text>`
const lead = (x, v) => `<text x="${x}" y="19.5" font-size="${D.size}" ${pinW(v)} class="lead">${esc(v)}</text>`
const fig = (x, v) => `<text x="${x}" y="19.5" font-size="${D.size}" ${pinW(v)} class="fig">${esc(v)}</text>`
const rule = (x) => `<rect x="${x}" y="${CAP.top}" width="1" height="${CAP.h}" class="rule"/>`

// A target, as usage-band draws its cache icon
// a neutral target in the theme's ink, for a row not yet done
const plainIcon = () =>
  `<g class="ico" stroke-width="1.2"><circle cx="5" cy="5" r="4.4"/><circle cx="5" cy="5" r="2.1"/><circle cx="5" cy="5" r="0.7" class="icod"/></g>`
const icon = (color) =>
  `<g fill="none" stroke="${color}" stroke-width="1.2">` +
  `<circle cx="5" cy="5" r="4.4"/><circle cx="5" cy="5" r="2.1"/><circle cx="5" cy="5" r="0.7" fill="${color}"/></g>`

const HEAD =
  `<style>` +
  `:root{color-scheme:light dark;background:transparent}` +
  `text{font-family:Inter,"SF Pro Text",system-ui,-apple-system,"Segoe UI",sans-serif;font-weight:500;font-feature-settings:"tnum","cv05"}` +
  `.track{fill:var(--h);fill-opacity:.22}` +
  `.ink{fill:var(--l)}.mute{fill:#8b8f97;font-weight:400}.rule{fill:#000;fill-opacity:.1}.fig{fill:#2b2f36}.lead{fill:#2b2f36;font-weight:400}.bar{fill:#5b6270}.trk{fill:#5b6270;fill-opacity:.2}.ico{stroke:#6b7280;fill:none}.icod{fill:#6b7280}` +
  `@media (prefers-color-scheme:dark){.ink{fill:var(--d)}.mute{fill:#9aa0a8}.rule{fill:#fff;fill-opacity:.13}.fig{fill:#eef0f3}.lead{fill:#eef0f3}.bar{fill:#d5d8dd}.trk{fill:#d5d8dd;fill-opacity:.16}.ico{stroke:#c9ccd1}.icod{fill:#c9ccd1}}` +
  `</style>` +
  `<defs><linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>` +
  `<stop offset=".5" stop-color="#fff" stop-opacity=".8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>`

export function rowSvg(r) {
  const done = r.state === 'done'
  const defs = []
  const parts = [`<g transform="translate(1 ${CAP.top})">${done ? icon(lighten(HUE.done, -0.15)) : plainIcon()}</g>`]
  let x = 1 + D.icon + 6
  const put = (draw, v, gap = D.inner) => {
    parts.push(draw(x, v))
    x += textW(v) + gap
  }
  put(done ? (px, v) => ink(HUE.done, px, v) : lead, r.title)
  if (r.state === 'running' || done) {
    const y = (D.h - D.barH) / 2
    const rad = D.barH / 2
    const fillW = Math.max(r.fraction > 0 ? D.barH : 0, Math.min(D.barW, D.barW * r.fraction))
    const shine = (times) =>
      `<g clip-path="url(#c-goal)"><rect y="${y}" width="18" height="${D.barH}" fill="url(#shine)">` +
      `<animate attributeName="x" values="${x - 18};${x + D.barW};${x + D.barW}" keyTimes="0;0.62;1" dur="${times ? '1.3s' : '2.6s'}" repeatCount="${times || 'indefinite'}" fill="freeze"/></rect></g>`
    defs.push(`<clipPath id="c-goal"><rect x="${x}" y="${y}" width="${fillW}" height="${D.barH}" rx="${rad}"/></clipPath>`)
    if (done) {
      parts.push(
        `<rect x="${x}" y="${y}" width="${D.barW}" height="${D.barH}" rx="${rad}" class="track" style="--h:${HUE.done}"/>`,
        `<rect x="${x}" y="${y}" width="${fillW}" height="${D.barH}" rx="${rad}" fill="${lighten(HUE.done, -0.12)}"/>`,
      )
      // just finished: a shine runs over the full bar twice, then it rests
      if (r.celebrate) parts.push(shine(2))
    } else {
      parts.push(
        `<rect x="${x}" y="${y}" width="${D.barW}" height="${D.barH}" rx="${rad}" class="trk"/>`,
        `<rect x="${x}" y="${y}" width="${fillW}" height="${D.barH}" rx="${rad}" class="bar"/>`,
        shine(0),
      )
    }
    x += D.barW + D.inner
  }
  if (r.figure) put(done ? (px, v) => ink(HUE.done, px, v) : fig, r.figure)
  if (r.detail) {
    parts.push(rule(x))
    x += 1 + D.inner
    put(mute, r.detail)
  }
  const base = Math.max(1, Math.ceil(x - D.inner + 2))
  const width = scaled(base)
  const height = scaled(D.h)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${base} ${D.h}" style="color-scheme:light dark;background:transparent">` +
    HEAD + (defs.length ? `<defs>${defs.join('')}</defs>` : '') + parts.join('') + `</svg>`
  return { svg, width, height, base }
}

// A window `w` px wide onto a drawn row, starting `x` px in (negative: blank room to its left)
export function cropSvg(row, x, w) {
  const k = row.base / row.width
  return row.svg.replace(/^<svg([^>]*?) width="[^"]*"([^>]*?) viewBox="[^"]*"/, `<svg$1 width="${w}"$2 viewBox="${x * k} 0 ${w * k} ${D.h}"`)
}

// ---- terminal: one row of spans in usage-band's style

export function rowSpans(r, columns = 100) {
  const hue = r.state === 'done' ? HUE.done : HUE.goal
  const done = r.state === 'done'
  const spans = [{ text: '◎ ', color: done ? hue : undefined }]
  spans.push(done ? { text: r.title, color: hue } : { text: r.title, bold: true })
  if (r.state === 'running') {
    const cells = columns >= 80 ? 10 : 6
    const filled = Math.max(r.fraction > 0 ? 1 : 0, Math.min(cells, Math.round(r.fraction * cells)))
    spans.push({ text: '  ' })
    for (let i = 0; i < filled; i++) {
      spans.push({ text: '■', color: hue })
    }
    if (cells > filled) spans.push({ text: '■'.repeat(cells - filled), color: TRACK })
  }
  if (r.figure) spans.push({ text: '  ' + r.figure, color: done ? hue : undefined })
  if (r.detail) spans.push({ text: ' · ' + r.detail, dim: true })
  return spans
}

// ---- desktop: the steps card, one SVG that fills the desktop's hover frame

// The desktop lifts the card into a popover frame of its own (renderer source, 2026-10-07):
// `max-width: min(360px, 100vw - 16px)`, border-box, 12px of padding each side (measured on two
// screenshots), the image inside held to `max-width: 100%`. So the frame is never wider than 360
// and an image wider than 336 is scaled down, its type with it (380 read at 88%).
// The steps read at the row's own 13px, regular weight, the same type as the title,
// on a card of one fixed width, the frame's full 360 without scaling it down
export const FRAME = { w: 360, pad: 12 }
const STEP = { h: 22, top: 1, size: 13, gap: 28 }
export const CARD = { min: FRAME.w - FRAME.pad * 2, max: FRAME.w - FRAME.pad * 2, pad: 2 }
// the step it is on: ▶ while work runs, ⏸ once the turn has stopped with nothing left running
// (text presentation, not the colour emoji)
const MARK = { done: '✓', active: '▶', paused: '⏸\uFE0E', pending: '○' }
const TIME_ROOM = '12m 34s' // the time column is at least this wide

// Cut text to fit `room` px, by the same measure the row uses
export const fit = (v, room, size) => {
  if (textW(v, size) <= room) return v
  const chars = [...v]
  while (chars.length && textW(chars.join('') + '…', size) > room) chars.pop()
  return chars.join('') + '…'
}

export function stepsSvg(steps) {
  // a clear column of space between a step's name and its time, never the name running into it;
  // every name is cut at the same place, a time there or not yet, so the time always has its room
  // and a name does not shrink when its step starts
  const tails = steps.map((t) => Math.max(t.tail ? textW(t.tail, STEP.size) : 0, textW(TIME_ROOM, STEP.size)) + STEP.gap)
  const want = Math.max(...steps.map((t, i) => 18 + textW(t.title, STEP.size) + tails[i]), 0) + CARD.pad * 2
  const width = Math.round(Math.min(CARD.max, Math.max(CARD.min, want)))
  const h = STEP.top * 2 + steps.length * STEP.h - 4
  const defs = []
  const rows = steps.map((s, i) => {
    const y = STEP.top + i * STEP.h + 15
    const hue = s.status === 'done' ? HUE.done : null
    const mark = MARK[s.status] || '○'
    const on = s.status === 'active' || s.status === 'paused'
    const tail = s.tail ? s.tail : ''
    const x0 = CARD.pad
    const tx = x0 + 18
    const title = fit(s.title, width - tx - CARD.pad - tails[i], STEP.size)
    const markSvg = hue
      ? `<text x="${x0}" y="${y}" font-size="${STEP.size}" class="ink" style="--l:${lighten(hue, -0.38)};--d:${lighten(hue, 0.25)}">${mark}</text>`
      : `<text x="${x0}" y="${y}" font-size="${STEP.size}" class="${on ? 'lead' : 'mute'}">${mark}</text>`
    const titleSvg = on
      ? `<text x="${tx}" y="${y}" font-size="${STEP.size}" class="lead">${esc(title)}</text>`
      : `<text x="${tx}" y="${y}" font-size="${STEP.size}" class="${s.status === 'pending' ? 'lead' : 'mute'}">${esc(title)}</text>`
    const tailSvg = tail ? `<text x="${width - CARD.pad}" y="${y}" font-size="${STEP.size}" text-anchor="end" class="mute">${esc(tail)}</text>` : ''
    return markSvg + titleSvg + tailSvg
  })
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" style="color-scheme:light dark;background:transparent">` +
    HEAD + (defs.length ? `<defs>${defs.join('')}</defs>` : '') + rows.join('') + `</svg>`
  return { svg, width, height: h }
}

// ---- desktop: other chats, a small area at the right end of the row and the card it pops

// The desktop row is one fixed line, as wide as usage-band's band beneath it (632-643 px on Neo's
// screenshots, 2026-10-09), so nothing moves when the text changes: this chat's row from the left end,
// cut to fit, and a fixed area at the right end for the other chats (Neo: 缩来缩去、动来动去的，体验并不好)
export const LINE = { w: 640, others: 170, gap: 16 }
export const ROW_ROOM = LINE.w - LINE.others - LINE.gap

// This chat's row cut to `room`: the title gives way, the rest stays whole
export function fitRow(r, room = ROW_ROOM) {
  const row = rowSvg(r)
  if (row.width <= room || !r.title) return row
  const title = fit(r.title, Math.max(0, textW(r.title) - (row.width - room)), D.size)
  return rowSvg({ ...r, title })
}

// The right end's area, LINE.others wide whatever it says, its text set flush right:
// "其他对话 N | M 在跑", with a stack of two cards for its icon; blank with no other chat
export function othersSvg(n, running) {
  const width = LINE.others
  const parts = []
  if (n) {
    const label = `其他对话 ${n}`
    const tail = running ? `${running} 在跑` : '没在跑'
    let x = width - 2 - textW(tail)
    parts.push(mute(x, tail))
    x -= D.inner + 1
    parts.push(rule(x))
    x -= D.inner + textW(label)
    parts.push(lead(x, label))
    x -= 6 + D.icon
    parts.push(`<g class="ico" stroke-width="1.2" transform="translate(${x} ${CAP.top})"><rect x="2.5" y="0.6" width="7" height="6" rx="1.2"/><rect x="0.6" y="3.4" width="7" height="6" rx="1.2"/></g>`)
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${D.h}" viewBox="0 0 ${width} ${D.h}" style="color-scheme:light dark;background:transparent">` +
    HEAD + parts.join('') + `</svg>`
  return { svg, width, height: D.h }
}

const OTHER = { line: 20, gap: 10, barW: 120 }

// Two lines a chat: its project and goal, then a bar, done of total and time left (or 完成 ✓).
// items: { name, title, fraction, figure, right, done }
export function othersCardSvg(items) {
  const width = CARD.max
  const rows = []
  let y = 14
  for (const it of items) {
    const nameW = textW(it.name, STEP.size) + 8
    rows.push(`<text x="0" y="${y}" font-size="${STEP.size}" font-weight="600" class="lead">${esc(it.name)}</text>`)
    rows.push(`<text x="${nameW}" y="${y}" font-size="${STEP.size}" class="mute">${esc(fit(it.title, width - nameW, STEP.size))}</text>`)
    const y2 = y + OTHER.line
    const by = y2 - 8
    const fw = it.done ? OTHER.barW : Math.max(it.fraction > 0 ? D.barH : 0, Math.min(OTHER.barW, OTHER.barW * it.fraction))
    rows.push(it.done
      ? `<rect x="0" y="${by}" width="${OTHER.barW}" height="${D.barH}" rx="${D.barH / 2}" fill="${lighten(HUE.done, -0.12)}"/>`
      : `<rect x="0" y="${by}" width="${OTHER.barW}" height="${D.barH}" rx="${D.barH / 2}" class="trk"/><rect x="0" y="${by}" width="${fw}" height="${D.barH}" rx="${D.barH / 2}" class="bar"/>`)
    if (it.figure) rows.push(`<text x="${OTHER.barW + 10}" y="${y2}" font-size="${STEP.size}" class="fig">${esc(it.figure)}</text>`)
    if (it.right) {
      rows.push(it.done
        ? `<text x="${width}" y="${y2}" font-size="${STEP.size}" text-anchor="end" class="ink" style="--l:${lighten(HUE.done, -0.38)};--d:${lighten(HUE.done, 0.25)}">${esc(it.right)}</text>`
        : `<text x="${width}" y="${y2}" font-size="${STEP.size}" text-anchor="end" class="mute">${esc(it.right)}</text>`)
    }
    y = y2 + OTHER.line + OTHER.gap
  }
  const h = Math.max(1, y - OTHER.line - OTHER.gap + 6)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}" style="color-scheme:light dark;background:transparent">` +
    HEAD + rows.join('') + `</svg>`
  return { svg, width, height: h }
}
