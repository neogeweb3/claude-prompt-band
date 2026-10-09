import { expect, mock, test } from 'claude-code/testing'

import { applyAction, autoPlan, foldBackground, ledgerLine, newGoal, shown } from '../hooks/plan.mjs'
import { CARD, FRAME, LINE, ROW_ROOM, SCALE, ago, cropSvg, rowOf, rowSpans, rowSvg, stepsSvg, textW } from '../hooks/row.mjs'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 140 } as never,
} as const

const goal = (over = {}) => ({
  title: '测试全绿并提交',
  status: 'running',
  startedAt: 0,
  planAt: 1,
  endedAt: 0,
  ...over,
})
const prog = { fraction: 0.5, doneN: 2, n: 4, pct: 50 }

// The images inside the row's own keyed Box (the row, then its steps card), leaving out the
// other chats' area at the right end of the desktop line
type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
const svgsIn = (n: unknown): Node[] => {
  if (!n || typeof n !== 'object') return []
  const node = n as Node
  return [...(node.type === 'Svg' ? [node] : []), ...(node.children ?? []).flatMap(svgsIn)]
}
// A stand-in for grep over a chat's log: the lines holding the pattern (argv: grep -m 3 -F <pattern> <path>)
const grepLog = (log: () => string) => (_$: unknown, e: unknown) => {
  const argv = (e as { argv: string[] }).argv
  const pattern = argv[argv.length - 2]!
  return { value: { stdout: log().split('\n').filter((l) => l.includes(pattern)).join('\n'), stderr: '', exitCode: 0 } }
}
const rowImgs = async (ui: { find: (q: object) => Promise<unknown> }) => svgsIn(await ui.find({ type: 'Box', key: 'goal-row' }))

test('a chat that has done nothing has no row at all, and never a /goal hint or 空闲', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['band'] }))
  mock.clock(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface, ...BAND })
    const all = JSON.stringify(await ui.find({ type: 'Text', text: 'band' })) + JSON.stringify(await ui.findAll({ type: 'Svg' }))
    expect(await ui.find({ type: 'Text', text: 'band' })).toBeDefined()
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(0)
    expect(all).not.toContain('空闲')
    expect(all).not.toContain('/goal')
    await ui.unmount()
  }
})

test('a task with no plan reads "working" while the turn runs, then the last turn, never 空闲', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on)
  const row = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'terminal', ...BAND })
    const text = JSON.stringify(await ui.find({ type: 'Box', key: 'goal-row' }) ?? await ui.find({ type: 'Box' }))
    await ui.unmount()
    return text
  }
  await clock.advance(60000)
  await $.turn.start({ text: '修一下这个 bug', turnId: 't1' })
  expect(await row()).toContain('工作中')
  await $.tool.call({ tool: 'Read', file_path: '/a' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect(await row()).toContain('2 个操作')
  await clock.advance(3 * 60000)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  const after = await row()
  expect(after).toContain('上一轮')
  expect(after).toContain('2 个操作 · 用时 3m')
  expect(after).not.toContain('工作中')
  expect(after).not.toContain('空闲')
})

test('a turn a few tools deep with no plan gets one hidden reminder to plan, once', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  mock.clock(on)
  const call = () => $.tool.call({ tool: 'Bash', command: 'ls' } as never) as Promise<{ context?: readonly string[] }>
  await $.turn.start({ text: '继续', turnId: 't1' })
  expect((await call()).context).toBeUndefined()
  expect((await call()).context).toBeUndefined()
  const third = await call()
  expect(third.context?.[0]).toContain('mcp__goal-meter__tasks')
  expect(third.context?.[0]).toContain('"plan"')
  expect((await call()).context).toBeUndefined()
  // a new turn may be reminded again
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  await $.turn.start({ text: '再来', turnId: 't2' })
  await call(); await call()
  expect((await call()).context).toHaveLength(1)
})

test('no reminder once a plan is running', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  mock.clock(on)
  await $.turn.start({ text: '做个功能', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal: '做个功能', tasks: [{ title: '写', size: 'M' }] })
  // (with its step marked under way: a plan with none gets its own reminder, tested below)
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'start', id: 1 } as never)
  for (let i = 0; i < 5; i++) {
    const r = (await $.tool.call({ tool: 'Bash', command: 'ls' } as never)) as { context?: readonly string[] }
    expect(r.context).toBeUndefined()
  }
})

test('the row stacks on top of what another mod drew, never replacing it', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Text({ children: ['5h 5%'] }))
  on('tool.call', () => ({ result: 'engine' }))
  mock.clock(on)
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal: '叠放', tasks: [{ title: '一', size: 'S' }] } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '5h 5%' })).toBeDefined()
    // and the goal row is really there too, above it
    const top = (await ui.find({ type: 'Box' })) as { children: unknown[] }
    expect(JSON.stringify(top.children[0])).toContain('叠放')
    expect(JSON.stringify(top.children[1])).toContain('5h 5%')
    await ui.unmount()
  }
})

test('a running plan is one row: the whole title, a band-length bar, done of total, ETA; no rainbow', async () => {
  const r = rowOf(goal(), prog, 8 * 60000)
  expect(r).toEqual({ state: 'running', title: '测试全绿并提交', fraction: 0.5, figure: '2/4 · 50%', detail: '剩约 8m' })
  const { svg, height } = rowSvg(r!)
  expect(height).toBe(30)
  expect(svg).toContain('<animate')
  expect(svg).toContain('测试全绿并提交')
  expect(svg).toContain('2/4 · 50%')
  // plain colours: no gradients but the shine, no rose, no rainbow
  expect(svg).not.toContain('url(#rb-')
  expect(svg).not.toContain('animateTransform')
  expect(svg).not.toContain('e58fb6')
  expect(svg).toContain('class="bar"')
  // the bar is usage-band's length
  expect(svg).toContain('width="76"')
  const spans = rowSpans(r!, 120)
  expect(spans.map(s => s.text).join('')).toBe('◎ 测试全绿并提交  ■■■■■■■■■■  2/4 · 50% · 剩约 8m')
  // a long title is kept far longer than before (16 with a step name beside it)
  expect(rowOf(goal({ title: '核对 03-12 的报表数据，并找出出错的那一处地方' }), prog, 0)!.title).toBe('核对 03-12 的报表数据，并找出出错的那一处地方')
})

test('task sizes (S, M, L) never reach the row', async () => {
  const r = rowOf(goal(), prog, 0)!
  const text = rowSpans(r).map(s => s.text).join('') + rowSvg(r).svg
  expect(/\b[SML]\b/.test(text.replace(/<[^>]+>/g, ' ').replace(/viewBox|xmlns/g, ''))).toBe(false)
})

test('planning, done, an old finished plan, and the last turn read as they should', async () => {
  expect(rowOf(goal({ planAt: 0 }), prog, 0)!.detail).toBe('列步骤中…')
  expect(rowOf(goal({ status: 'met', endedAt: 12 * 60000 }), prog, 0)).toMatchObject({ state: 'done', figure: '完成 ✓', detail: '用时 12m' })
  // however long ago it finished, the plan stays on the row
  expect(rowOf(goal({ status: 'met', endedAt: 1 }), prog, 0)!.state).toBe('done')
  // a new task after one finished reads working, not the old plan's done
  expect(rowOf(goal({ status: 'met', endedAt: 1 }), prog, 0, { calls: 1 })!.state).toBe('working')
  // work after the plan ended: the last turn; work before it: the plan
  expect(rowOf(goal({ status: 'met', endedAt: 100 }), prog, 0, null, { calls: 4, ms: 90000, at: 200 })).toMatchObject({ state: 'last', detail: '4 个操作 · 用时 2m' })
  expect(rowOf(goal({ status: 'met', endedAt: 300 }), prog, 0, null, { calls: 4, ms: 90000, at: 200 })!.state).toBe('done')
  expect(rowOf(null, null, 0)).toBeNull()
})

test('collapsed to one row; the steps float in a hover card that moves nothing, sizes left out', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  mock.clock(on)
  await $.tool.call({
    tool: 'mcp__goal-meter__tasks',
    action: 'plan',
    tasks: [{ title: '读代码', size: 'S' }, { title: '改样式', size: 'L' }],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface, ...BAND })
    const scope = await ui.find({ type: 'Box', key: 'goal-row' })
    expect(scope).toBeDefined()
    const hidden = JSON.stringify(scope)
    expect(hidden).toContain('"display":"none"')
    expect(hidden).toContain('"position":"absolute"')
    // centred over the row, as if it grew out of it: on the desktop the card hangs off the
    // centred row at its full width; in the terminal a full-width strip centres it
    if (surface === 'terminal') {
      expect(hidden).toContain('"width":"100%"')
      expect(hidden).toContain('"justifyContent":"center"')
      expect(await ui.find({ type: 'Text', text: '读代码' })).toBeDefined()
    } else {
      // The desktop lifts the card into a popover whose left edge is the keyed Box's left edge
      // and whose frame is always FRAME.w wide (renderer source, 2026-10-07). The keyed Box holds
      // the row padded to its fixed share of the line, and the card fills the frame unscaled.
      const imgs = await rowImgs(ui)
      expect(imgs).toHaveLength(2) // the row, the card
      expect(imgs[0]!.props!.width).toBe(LINE.w - LINE.others)
      expect(imgs[1]!.props!.width).toBe(FRAME.w - FRAME.pad * 2)
      expect(String(imgs[1]!.props!.source)).toContain('改样式')
      expect(hidden).not.toContain('goal-card-anchor')
    }
    expect(await ui.find({ type: 'Text', text: /^S\b|^L\b/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('on the desktop the line is one fixed width whatever the row says, a long title cut to fit, and every image has an alt', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  mock.clock(on)
  // 1.8.1's centring strip had alt '' and the desktop dropped it: an alt must hold a non-blank
  const alts = (imgs: { props: Record<string, unknown> }[]) => imgs.every((i) => String(i.props.alt).trim() !== '')
  const long = '一个很长很长的任务名字，长到整行远比留给它的那一截还要宽出一大截'
  for (const title of ['短', long]) {
    await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal: title, tasks: [{ title: '读代码' }, { title: '改样式' }] })
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const imgs = await ui.findAll({ type: 'Svg' })
    expect(alts(imgs)).toBe(true)
    const row = (await rowImgs(ui))[0]!
    // a blank image holds the line's width, short title or long; the row is laid over its left end
    expect(imgs[0]!.props.width).toBe(LINE.w)
    expect(row.props!.width).toBe(LINE.w - LINE.others)
    expect(JSON.stringify(await ui.find({ type: 'Box', key: 'goal-row' }))).toContain('"left":0')
    // what is drawn of the row stays within its room; a long title gives way, cut with …
    const drawn = rowSvg({ state: 'running', title, fraction: 0, figure: '0/2 · 0%', detail: '' }).width
    if (title === long) {
      expect(drawn).toBeGreaterThan(ROW_ROOM)
      expect(String(row.props!.source)).toContain('…')
    } else expect(String(row.props!.source)).not.toContain('…')
    // alone, there is no other chats' area and nothing else pops
    expect(await ui.find({ type: 'Box', key: 'goal-others' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a long step name stops well short of its time', () => {
  const long = '读现有排序模型、缓存层算法和报表页生成路径并核对每一处细节'
  const card = stepsSvg([{ status: 'active', title: long, tail: '1m 00s' }])
  const title = card.svg.match(new RegExp(`x="${CARD.pad + 18}"[^>]*>([^<]*)<`))![1]!
  expect(title.endsWith('…')).toBe(true)
  // the name's right end and the time's left end are at least 28px apart
  const nameEnd = CARD.pad + 18 + textW(title, 13)
  const timeStart = CARD.max - CARD.pad - textW('1m 00s', 13)
  expect(timeStart - nameEnd).toBeGreaterThanOrEqual(28)
})

test('every long name is cut at the same place, with or without a time, leaving the time its room', () => {
  // a real step from another chat (2026-10-07) that ran to the card's edge with no time beside it
  const long = '写分层缓存模型 + 本地队列模型 + 重试逻辑并编译'
  const tx = CARD.pad + 18
  const titleOf = (svg: string) => svg.match(new RegExp(`x="${tx}"[^>]*>([^<]*)<`))![1]!
  const bare = titleOf(stepsSvg([{ status: 'pending', title: long, tail: '' }]).svg)
  const timed = titleOf(stepsSvg([{ status: 'done', title: long, tail: '4m 16s' }]).svg)
  const dash = titleOf(stepsSvg([{ status: 'done', title: long, tail: '—' }]).svg)
  expect(bare.endsWith('…')).toBe(true)
  expect(timed).toBe(bare)
  expect(dash).toBe(bare)
  expect(CARD.max - CARD.pad - textW('12m 34s', 13) - (tx + textW(bare, 13))).toBeGreaterThanOrEqual(28)
})

test('a crop is a window onto the same drawing', () => {
  const row = rowSvg(rowOf(goal(), prog, 0)!)
  const piece = cropSvg(row, 10, 50)
  expect(piece).toContain('width="50"')
  expect(piece).toContain('viewBox="10 0 50 30"')
  // the drawing itself is untouched
  expect(piece.slice(piece.indexOf('>'))).toBe(row.svg.slice(row.svg.indexOf('>')))
})

test('Latin text is measured narrow enough not to be stretched apart', async () => {
  // 'No goal' in Inter 13px is about 50px wide; the old flat guess gave 56+ and spread the letters
  expect(textW('No goal')).toBeLessThan(54)
  expect(textW('在 /tmp')).toBeGreaterThan(textW('a /tmp'))
})

test('on by default: the system prompt asks Claude to plan multi-step work, once, stably', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' as const }] }))
  const input = { model: 'm', promptModel: 'm', surfaces: [], tools: ['Bash', 'mcp__goal-meter__tasks'], outputStyle: null, traits: [] }
  const a = await $.prompt.compose(input as never)
  const mine = a.sections.find(s => s.id === 'goal-meter:auto-plan')
  expect(mine?.scope).toBe('session')
  expect(mine?.text).toContain('mcp__goal-meter__tasks')
  expect(mine?.text).toContain('"plan"')
  // the same text every render, so the prompt cache holds
  const b = await $.prompt.compose(input as never)
  expect(b.sections.find(s => s.id === 'goal-meter:auto-plan')?.text).toBe(mine?.text)
  // nothing added where the tool is not offered
  const c = await $.prompt.compose({ ...input, tools: ['Bash'] } as never)
  expect(c.sections.map(s => s.id)).toEqual(['intro'])
})

test('the plan prompt asks for step titles short enough for one line of the card', () => {
  expect(autoPlan('t')).toContain('within 15 Chinese characters')
  // 15 of them, with a time of 12m 34s, fit one line uncut
  const card = stepsSvg([{ status: 'done', title: '字'.repeat(15), tail: '12m 34s' }])
  expect(card.svg).toContain('字'.repeat(15) + '<')
})

test('a plan without /goal shows under the name Claude gave; a new name starts a new plan', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  mock.clock(on)
  const plan = (goal: string, titles: string[]) =>
    $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal, tasks: titles.map(title => ({ title, size: 'M' })) })
  await plan('整理周报', ['收数据', '写结论'])
  let ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '整理周报' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0\/2/ })).toBeDefined()
  await ui.unmount()
  await plan('修登录 bug', ['复现', '修', '验证'])
  ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'terminal', ...BAND })
  expect(await ui.find({ type: 'Text', text: '修登录 bug' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0\/3/ })).toBeDefined()
  await ui.unmount()
})

test('the row leaves the step name out (room for the title); the card names it', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  await tasks('plan', { goal: '美化进度行', tasks: [{ title: '显示当前步骤', size: 'M' }, { title: '完成动画', size: 'M' }] })
  await tasks('start', { id: 1 })
  const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
  const imgs = await rowImgs(ui)
  await ui.unmount()
  expect(String(imgs[0]!.props!.source)).toContain('美化进度行')
  expect(String(imgs[0]!.props!.source)).not.toContain('显示当前步骤')
  expect(String(imgs.at(-1)!.props!.source)).toContain('显示当前步骤')
})

test('a plan just finished: a full green bar a shine runs over twice; later, the bar alone', async () => {
  const done = (celebrate: boolean) => rowSvg(rowOf(goal({ status: 'met', endedAt: 5 * 60000, celebrate }), prog, 0)!).svg
  const party = done(true)
  expect(party).toContain('url(#shine)')
  expect(party).toContain('repeatCount="2"')
  expect(party).not.toContain('rb-bar')
  const calm = done(false)
  expect(calm).not.toContain('<animate')
  // the full bar is drawn in both
  expect(calm).toContain('class="track"')
  expect(rowOf(goal({ status: 'met', endedAt: 5 * 60000 }), prog, 0)!.detail).toBe('用时 5m')
})

test('a finished plan celebrates only in the first seconds after it ends', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on)
  const svg = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const s = String((await rowImgs(ui))[0]!.props!.source)
    await ui.unmount()
    return s
  }
  await clock.advance(60000) // the mock clock starts at 0, which reads as "never ended"
  await $.turn.start({ text: '做', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal: '小活', tasks: [{ title: '一步', size: 'S' }] } as never)
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'done', id: 1 } as never)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(await svg()).toContain('repeatCount="2"')
  await clock.advance(20000)
  expect(await svg()).not.toContain('repeatCount="2"')
})

test('the row is drawn at usage-band\'s size; the card in the same type, one width within the frame', async () => {
  expect(SCALE).toBe(1)
  expect(rowSvg(rowOf(goal(), prog, 0)!).height).toBe(30)
  const long = '这是一个非常非常长的步骤名字，长到一行放不下还要再长一点'
  const card = stepsSvg([{ status: 'active', title: long, tail: '2m' }, { status: 'pending', title: '短', tail: '' }])
  expect(card.width).toBe(CARD.max)
  // the steps at the title's own 13px, nothing bold
  expect(card.svg).toContain('font-size="13"')
  expect(card.svg).not.toMatch(/font-weight="?6|font-weight:6/)
  expect(card.svg).toContain('…')
  // one fixed width, short steps or long: as wide as the frame takes unscaled
  expect(stepsSvg([{ status: 'pending', title: '短', tail: '' }]).width).toBe(CARD.max)
  // no margin of its own: the first mark sits at the card's edge
  expect(card.svg).toContain(`x="${CARD.pad}"`)
})

test('a finished step shows its time; one never started (marked done with others) shows a dash, never 0s', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  await clock.advance(60000)
  await tasks('plan', { goal: '计时', tasks: [{ title: '甲', size: 'S' }, { title: '乙', size: 'S' }, { title: '丙', size: 'S' }] })
  await clock.advance(3 * 60000)
  await tasks('done', { id: 1 }) // started by itself with the plan
  await clock.advance(10000)
  await tasks('done', { ids: [2, 3] }) // 乙 started by itself when 甲 was done; 丙 never started
  const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
  const card = String((await rowImgs(ui)).at(-1)!.props!.source)
  await ui.unmount()
  const tails = [...card.matchAll(/text-anchor="end" class="mute">([^<]*)</g)].map(m => m[1])
  expect(tails).toEqual(['3m 00s', '10s', '—'])
})

test('a step worked on without being marked started still shows its clock, by the second', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const tails = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const card = String((await rowImgs(ui)).at(-1)!.props!.source)
    await ui.unmount()
    return [...card.matchAll(/text-anchor="end" class="mute">([^<]*)</g)].map(m => m[1])
  }
  await clock.advance(60000)
  await tasks('plan', { goal: '后台', tasks: [{ title: '甲', size: 'S' }, { title: '乙', size: 'S' }, { title: '丙', size: 'S' }] })
  await clock.advance(20000)
  await tasks('done', { id: 1 })
  // Claude went straight on to 乙 (a background task, say) without marking it started:
  // it counts from when 甲 finished; 丙 still shows nothing
  await clock.advance(38000)
  expect(await tails()).toEqual(['20s', '38s'])
  await clock.advance(1000)
  expect(await tails()).toEqual(['20s', '39s'])
  // once a step is marked under way, only that one runs a clock
  await tasks('start', { id: 3 })
  const t = await tails()
  expect(t[0]).toBe('20s')
  expect(t).toHaveLength(2) // 甲's time and 丙's clock: 乙 is no longer the step being worked on
})

test('when the turn ends and nothing runs in the background, the clocks stop and no time is left', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const view = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const imgs = await ui.findAll({ type: 'Svg' })
    const card = String((await rowImgs(ui)).at(-1)!.props!.source)
    await ui.unmount()
    return { row: imgs.map((i) => String(i.props.alt)).join(' '), tails: [...card.matchAll(/text-anchor="end" class="mute">([^<]*)</g)].map(m => m[1]), mark: card.includes('⏸') ? '⏸' : card.includes('▶') ? '▶' : '' }
  }
  const stop = (bg: number) => $.classic.Stop({ stop_hook_active: false, background_tasks: Array.from({ length: bg }, (_, i) => ({ id: 'b' + i, type: 'shell', status: 'running', description: 'x' })) } as never)
  await clock.advance(60000)
  await $.turn.start({ text: '做', turnId: 't1' })
  await tasks('plan', { goal: '收尾', tasks: [{ title: '甲' }, { title: '乙' }, { title: '丙' }, { title: '丁' }] })
  for (const id of [1, 2]) { await clock.advance(10000); await tasks('done', { id }) }
  await clock.advance(5000)
  // 丙 started by itself; a background task it launched is still carrying it when the turn stops: its clock and the estimate go on
  await $.tool.call({ tool: 'Bash', command: 'run', description: 'x', run_in_background: true } as never)
  await stop(1)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  await clock.advance(33000)
  let v = await view()
  // the background task is 丙's, still running under it: set under 丙 with its clock, not a step of its own
  expect(v.tails).toEqual(['10s', '10s', '38s', '33s'])
  expect(v.mark).toBe('▶')
  expect(v.row).toContain('剩约')
  expect(v.mark).toBe('▶') // the background task is still at it
  // the background task woke a turn that ended with nothing left running: the work waits on the person
  await $.turn.start({ text: '', turnId: 't2' })
  await stop(0)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't2' })
  await clock.advance(60000)
  v = await view()
  expect(v.tails).toEqual(['10s', '10s', '38s', '33s']) // 丙 stands where the work stopped; its background run, ended, stays listed under it (✓ 33s)
  expect(v.row).not.toContain('剩约')
  // the turn stopped with nothing running: the step it is on reads paused (a real chat, 2026-10-07 16:12)
  expect(v.mark).toBe('⏸')
  // taking up 丁 out of order puts 丙 back (it had only started by itself); 丁's clock stops with the work
  await $.turn.start({ text: '继续', turnId: 't3' })
  await tasks('start', { id: 4 })
  await clock.advance(7000)
  expect((await view()).mark).toBe('▶') // a turn at work again
  await stop(0)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't3' })
  await clock.advance(120000)
  v = await view()
  expect(v.tails).toEqual(['10s', '10s', '7s'])
  expect(v.mark).toBe('⏸')
})

test('a plan marked only with "done" times every step; a "done" for a step never started says so', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never) as Promise<{ result?: string }>
  await clock.advance(60000)
  await tasks('plan', { goal: '只标完成', tasks: [{ title: '甲' }, { title: '乙' }, { title: '丙' }, { title: '丁' }] })
  await clock.advance(42000)
  expect((await tasks('done', { id: 1 })).result).not.toContain('without having started')
  await clock.advance(65000)
  await tasks('done', { id: 2 })
  await clock.advance(9000)
  // 丙 is under way by itself; 丁 marked with it at the end never started
  const r = await tasks('done', { ids: [3, 4] })
  expect(r.result).toContain('1 step(s) marked done without having started')
  const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
  const card = String((await rowImgs(ui)).at(-1)!.props!.source)
  await ui.unmount()
  expect([...card.matchAll(/text-anchor="end" class="mute">([^<]*)</g)].map(m => m[1])).toEqual(['42s', '1m 05s', '9s', '—'])
})

test('the time left counts down while a step runs, and a late step is not taken to be nearly done', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const left = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const alt = (await ui.findAll({ type: 'Svg' })).map((i) => String(i.props.alt)).join(' ')
    await ui.unmount()
    return (alt.match(/剩约 (\S+)/) || [])[1]
  }
  // a real plan of 2026-10-07 08:52, at its own times: the old estimate read 6m with
  // the gate 35s in, 11m at 7m 58s
  const run = async (minutes: number) => {
    await clock.advance(60000)
    await $.turn.start({ text: '做', turnId: 't' + minutes })
    await tasks('plan', { goal: '加载提示 + 完整测试', tasks: [{ title: '读', size: 'S' }, { title: '定', size: 'M' }, { title: '写', size: 'M' }, { title: '测', size: 'M' }, { title: '门禁', size: 'L' }, { title: '汇报', size: 'S' }] })
    for (const [id, ms] of [[1, 40000], [2, 324000], [3, 28000], [4, 239000]]) { await clock.advance(ms); await tasks('done', { id }) }
    if (minutes) await tasks('start', { id: 5, minutes })
    await clock.advance(35000)
    const a = await left()
    await clock.advance(443000)
    return [a, await left()]
  }
  // by the pace of the steps done (90s a size unit) the gate takes 4m 30s and counts down; at
  // 7m 58s it is 3m 28s late and taken to need that again, plus 汇报's minute and a half
  expect(await run(0)).toEqual(['5m', '5m'])
})

test('Claude\'s own minutes for a step are what the time left counts down from', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const left = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const alt = (await ui.findAll({ type: 'Svg' })).map((i) => String(i.props.alt)).join(' ')
    await ui.unmount()
    return (alt.match(/剩约 (\S+)/) || [])[1]
  }
  // a real plan of 2026-10-07 08:52, at its own times: the old estimate read 6m with
  // the gate 35s in, 11m at 7m 58s
  const run = async (minutes: number) => {
    await clock.advance(60000)
    await $.turn.start({ text: '做', turnId: 't' + minutes })
    await tasks('plan', { goal: '加载提示 + 完整测试', tasks: [{ title: '读', size: 'S' }, { title: '定', size: 'M' }, { title: '写', size: 'M' }, { title: '测', size: 'M' }, { title: '门禁', size: 'L' }, { title: '汇报', size: 'S' }] })
    for (const [id, ms] of [[1, 40000], [2, 324000], [3, 28000], [4, 239000]]) { await clock.advance(ms); await tasks('done', { id }) }
    if (minutes) await tasks('start', { id: 5, minutes })
    await clock.advance(35000)
    const a = await left()
    await clock.advance(443000)
    return [a, await left()]
  }
  // Claude said the gate takes 18 minutes
  expect(await run(18)).toEqual(['19m', '12m'])
})

test('every step\'s minutes from Claude, scaled by how its estimates held up in this plan', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const left = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const alt = (await ui.findAll({ type: 'Svg' })).map((i) => String(i.props.alt)).join(' ')
    await ui.unmount()
    return (alt.match(/剩约 (\S+)/) || [])[1]
  }
  // a real plan's times; the minutes are made up (that chat gave none)
  const run = async (mins: number[]) => {
    await clock.advance(60000)
    await $.turn.start({ text: '做', turnId: 't' })
    await tasks('plan', { goal: '加载提示 + 完整测试', tasks: ['读', '定', '写', '测', '门禁', '汇报'].map((title, i) => ({ title, size: 'SMMMLS'[i], minutes: mins[i] })) })
    for (const [id, ms] of [[1, 40000], [2, 324000], [3, 28000], [4, 239000]]) { await clock.advance(ms); await tasks('done', { id }) }
    await clock.advance(35000)
    const a = await left()
    await clock.advance(443000)
    return [a, await left()]
  }
  // 17 minutes said for the four steps done, 10m 31s taken: the gate's 18 read as 11
  expect(await run([2, 5, 5, 5, 18, 2])).toEqual(['12m', '4m'])
})

test('a few one-minute steps that ran over do not stretch a long step\'s minutes', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  await clock.advance(60000)
  await $.turn.start({ text: '做', turnId: 't' })
  await tasks('plan', { goal: '门禁', tasks: ['读', '定', '写', '测', '门禁', '汇报'].map((title, i) => ({ title, size: 'SMMMLS'[i], minutes: [1, 1, 1, 1, 18, 2][i] })) })
  for (const [id, ms] of [[1, 40000], [2, 324000], [3, 28000], [4, 239000]]) { await clock.advance(ms); await tasks('done', { id }) }
  await clock.advance(35000)
  const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
  const alt = (await ui.findAll({ type: 'Svg' })).map((i) => String(i.props.alt)).join(' ')
  await ui.unmount()
  // 4 minutes said, 10m 31s taken: scaled, the gate would read 47 minutes; too little said yet to go by
  expect(alt).toContain('剩约 19m')
})

test('a step marked done while the next in the list had started by itself gets that time', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const T = (hms: string) => Date.parse('2026-10-08T' + hms + 'Z')
  let at = T('08:22:00')
  const to = async (hms: string) => { await clock.advance(T(hms) - at); at = T(hms) }
  // a real plan of 2026-10-08, at its own times
  await clock.advance(at)
  await $.turn.start({ text: '做', turnId: 't' })
  await to('08:22:19')
  await tasks('plan', { goal: '补审 Vitest + 列表增量更新', tasks: [{ title: '读源码', size: 'M' }, { title: '缩减', size: 'M' }, { title: '40 次对照', size: 'L' }, { title: '收消息', size: 'L' }, { title: '全量门禁', size: 'M' }] })
  await to('08:23:19'); await tasks('done', { id: 1 })
  await to('08:25:31'); await tasks('done', { id: 2 })
  await to('08:32:46'); await tasks('done', { id: 4 }) // while #3 (started by itself) ran in the background
  await to('08:36:52'); await tasks('add', { tasks: [{ title: '用户对 ID', size: 'S' }, { title: '旧日志归档', size: 'M' }, { title: '设置页', size: 'M' }] })
  await to('08:37:08'); await tasks('done', { ids: [3, 6] })
  await to('08:41:11'); await tasks('done', { id: 7 }) // done before #5, which the list put next
  await to('08:43:44'); await tasks('done', { id: 8 })
  await to('08:50:00')
  const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
  // the card is the image listing the steps (a long row adds pieces either side of it)
  const card = String((await ui.findAll({ type: 'Svg' })).find((i) => String(i.props.alt).startsWith('读源码'))!.props.source)
  await ui.unmount()
  // before: #5 ran from 08:37:08 and #4, #7, #8 read "—"; #6, marked in a batch with #3, still does
  expect([...card.matchAll(/text-anchor="end" class="mute">([^<]*)</g)].map(m => m[1])).toEqual(['1m 00s', '2m 12s', '4m 22s', '7m 15s', '6m 16s', '—', '4m 03s', '2m 33s'])
})

test('a step past its time asks Claude once for how much longer, and takes the answer from now', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const bash = async () => JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'sleep 1' } as never))
  const left = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const alt = (await ui.findAll({ type: 'Svg' })).map((i) => String(i.props.alt)).join(' ')
    await ui.unmount()
    return (alt.match(/剩约 (\S+)/) || [])[1]
  }
  await clock.advance(60000)
  await $.turn.start({ text: '做', turnId: 't' })
  await tasks('plan', { goal: '装机', tasks: [{ title: '门禁', size: 'L', minutes: 45 }, { title: '汇报', size: 'S', minutes: 2 }] })
  await clock.advance(44 * 60000)
  expect(await bash()).not.toContain('has run past')
  expect(await left()).toBe('3m')
  await clock.advance(16 * 60000)
  // 15 minutes late: taken to need 15 more, plus 汇报
  expect(await left()).toBe('17m')
  expect(await bash()).toContain('of the progress row has run past')
  expect(await bash()).not.toContain('has run past')
  // Claude: 10 more minutes from now
  await tasks('start', { id: 1, minutes: 10 })
  expect(await left()).toBe('12m')
  await clock.advance(11 * 60000)
  expect(await bash()).toContain('has run past') // late again: asked again
})

test('a long step is asked how much longer a quarter of the way in, again after a big change, then no more', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const bash = async () => JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'sleep 1' } as never))
  const min = (m: number) => clock.advance(m * 60000)
  await min(1)
  await $.turn.start({ text: '做', turnId: 't' })
  await tasks('plan', { goal: '门禁', tasks: [{ title: '门禁', size: 'L', minutes: 10 }, { title: '汇报', size: 'S', minutes: 2 }] })
  await min(2)
  expect(await bash()).not.toContain('progress row') // not yet a quarter of 10 minutes
  await min(0.75)
  expect(await bash()).toContain('has run 3 of the 10 minutes it was given')
  expect(await bash()).not.toContain('progress row') // asked once
  // the owner's example: it will take 20 in all, so 17 more: asked again a quarter of 17 later
  await tasks('start', { id: 1, minutes: 17 })
  await min(4)
  expect(await bash()).not.toContain('progress row')
  await min(0.5)
  expect(await bash()).toContain('has run 7 of the 19.8 minutes it was given')
  // still the same finish: on course, no more early asks
  await tasks('start', { id: 1, minutes: 12.5 })
  await min(6)
  expect(await bash()).not.toContain('progress row')
  // only once it is late
  await min(7)
  expect(await bash()).toContain('has run past')
})

test('an answer that keeps the finish where it was ends the early asks at once', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const bash = async () => JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'sleep 1' } as never))
  const min = (m: number) => clock.advance(m * 60000)
  await min(1)
  await $.turn.start({ text: '做', turnId: 't' })
  await tasks('plan', { goal: '门禁', tasks: [{ title: '门禁', size: 'L', minutes: 20 }] })
  await min(5)
  expect(await bash()).toContain('has run 5 of the 20')
  await tasks('start', { id: 1, minutes: 16 }) // 21 in all: about where it was
  await min(6) // past a quarter of 16, still short of late
  expect(await bash()).not.toContain('progress row')
})

test('early asks stop after two, and a step under ten minutes is asked only once late', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const bash = async () => JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'sleep 1' } as never))
  const min = (m: number) => clock.advance(m * 60000)
  await min(1)
  await $.turn.start({ text: '做', turnId: 't' })
  await tasks('plan', { goal: '两步', tasks: [{ title: '长', size: 'L', minutes: 12 }, { title: '短', size: 'S', minutes: 8 }] })
  await min(3)
  expect(await bash()).toContain('has run 3 of the 12')
  await tasks('start', { id: 1, minutes: 30 }) // a big change: asked again
  await min(7.5)
  expect(await bash()).toContain('has run 11 of the 33')
  await tasks('start', { id: 1, minutes: 40 }) // another big change, but two early asks are the most
  await min(20)
  expect(await bash()).not.toContain('progress row')
  await min(20)
  await tasks('done', { id: 1 }) // on the minute it said: its estimates scale 短 by 1
  // 短 is under ten minutes: nothing until it runs past its 8
  await min(6)
  expect(await bash()).not.toContain('progress row')
  await min(3)
  expect(await bash()).toContain('has run past')
})

test('while Claude waits on background work, a fork of the conversation is asked how much longer', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  const asked: string[] = []
  on('store.set', () => ({ value: undefined }))
  on('command.run', () => ({}))
  // an op the host serves: a stand-in answers { value }
  on('model.fork', (_$, e) => { asked.push(e.prompt); return { value: { isAnswered: true, text: '30', usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 400000, cache_creation_input_tokens: 0 } } } })
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const left = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const alt = (await ui.findAll({ type: 'Svg' })).map((i) => String(i.props.alt)).join(' ')
    await ui.unmount()
    return (alt.match(/剩约 (\S+)/) || [])[1]
  }
  const min = (m: number) => clock.advance(m * 60000)
  await min(1)
  await $.turn.start({ text: '跑门禁', turnId: 't1' })
  await tasks('plan', { goal: '门禁', tasks: [{ title: '全量门禁', size: 'L', minutes: 20 }] })
  // the gate goes to the background and the turn ends: Claude makes no tool call until it wakes
  await $.tool.call({ tool: 'Bash', command: 'run', description: 'Run full verify-native gate', run_in_background: true } as never)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Run full verify-native gate' }] } as never)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  await min(4.5)
  expect(asked).toHaveLength(0) // not yet a quarter of 20
  await min(1)
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('has run 5 minutes; you gave it 20')
  expect(asked[0]).toContain('Run full verify-native gate')
  // the answer, 30 more from the ask (made on a 15-second check), is the step's new estimate:
  // two minutes on, 28 left
  await min(2)
  expect(await left()).toBe('28m')
  await min(8)
  expect(asked).toHaveLength(2) // a big change: once more, a quarter of 30 later
  // turned off: no more asks
  await $.command.run({ command: 'goals', args: 'ask off' } as never)
  await min(60)
  expect(asked).toHaveLength(2)
})

test('an answer is taken as given, so a step is not asked again and again (6 forks in 90 seconds, 2026-10-08)', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  const asked: string[] = []
  on('model.fork', (_$, e) => { asked.push(e.prompt); return { value: { isAnswered: true, text: '4', usage: { input_tokens: 130, output_tokens: 3, cache_read_input_tokens: 392041, cache_creation_input_tokens: 0 } } } })
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  await clock.advance(60000)
  await $.turn.start({ text: '核对', turnId: 't1' })
  // this repo's own chat: 9 minutes said for three steps that took 49 seconds
  await tasks('plan', { goal: '核对', tasks: [{ title: '找', size: 'S', minutes: 2 }, { title: '读', size: 'M', minutes: 4 }, { title: '日志', size: 'S', minutes: 3 }, { title: '对照', size: 'S', minutes: 3 }] })
  await clock.advance(16000); await tasks('done', { id: 1 })
  await clock.advance(33000); await tasks('done', { id: 2 })
  await clock.advance(1000); await tasks('done', { id: 3 })
  await $.tool.call({ tool: 'Bash', command: 'run', description: 'Wait for the gate', run_in_background: true } as never)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'Wait for the gate' }] } as never)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  // 对照's 3 minutes, scaled no lower than half: late at 1m 30s, asked once; the answer, 4 more
  // minutes from then, holds until it runs out
  await clock.advance(5 * 60000)
  expect(asked).toHaveLength(1)
  // late again past those 4 minutes: asked again, no sooner than two minutes on
  await clock.advance(2 * 60000)
  expect(asked).toHaveLength(2)
  // never more than four asks for a step
  await clock.advance(120 * 60000)
  expect(asked.length).toBeLessThanOrEqual(4)
})

test('a plan without minutes is asked for them once in a chat, in the tool\'s reply', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  mock.clock(on)
  const tasks = async (action: string, extra = {}) => String(((await $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)) as { result?: string }).result)
  // a chat begun before Claude was asked for minutes keeps that system prompt: the reply asks
  const first = await tasks('plan', { goal: '装机', tasks: [{ title: '构建', size: 'M' }, { title: '装', size: 'S' }] })
  expect(first).toContain('These steps have no "minutes"')
  expect(first).toContain('action "start", id 1 and "minutes"')
  // once in a chat: not on its next plan, a new task, either
  expect(await tasks('plan', { goal: '另一件事', tasks: [{ title: '查', size: 'S' }] })).not.toContain('no "minutes"')
  expect(await tasks('add', { tasks: [{ title: '再查', size: 'S' }] })).not.toContain('no "minutes"')
})

test('a plan that gives minutes is never asked for them', async ($, on) => {
  on('tool.call', () => ({ result: 'engine' }))
  mock.clock(on)
  const r = (await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal: '装机', tasks: [{ title: '构建', size: 'M', minutes: 8 }] } as never)) as { result?: string }
  expect(String(r.result)).not.toContain('no "minutes"')
})

test('the estimate ledger keeps what Claude first said, its later word, and what the step took', () => {
  const T0 = Date.parse('2026-10-08T14:00:00Z') // a real time: a start at 0 reads as not started
  const g = newGoal({ sessionId: 's', condition: '装机', now: T0 })
  const act = (input: object, now: number) => applyAction(g, input, { now: T0 + now })
  act({ action: 'plan', goal: '装机', tasks: [{ title: '门禁', size: 'L', minutes: 60 }, { title: '装', size: 'S', minutes: 3 }, { title: '报', size: 'S' }] }, 0)
  act({ action: 'start', id: 1, minutes: 90 }, 60000) // new word a minute in: 91 in all
  act({ action: 'done', id: 1 }, 40 * 60000)
  act({ action: 'done', ids: [2, 3] }, 41 * 60000) // 报 never started
  const [a, b, c] = g.tasks.map((t) => ledgerLine(t, { now: T0 + 41 * 60000, session: 's', model: 'claude-opus-5-5' }))
  expect([a.said, a.final, a.tookMin, a.reestimated, a.model]).toEqual([60, 91, 40, true, 'claude-opus-5-5'])
  expect([b.said, b.tookMin, b.untimed]).toEqual([3, 1, false])
  expect([c.said, c.tookMin, c.untimed]).toEqual([0, null, true])
})

test('every step done but a background task still running: not finished until it ends', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const row = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const alt = (await ui.findAll({ type: 'Svg' })).map((i) => String(i.props.alt)).join(' ')
    await ui.unmount()
    return alt
  }
  // what a real chat did (2026-10-07 11:57): launch the Codex build in the background,
  // mark the last step done, end the turn
  const stop = (bg: number) => $.classic.Stop({ stop_hook_active: false, background_tasks: Array.from({ length: bg }, (_, i) => ({ id: 'b' + i, type: 'shell', status: 'running', description: 'Codex stage 3' })) } as never)
  await clock.advance(60000)
  await $.turn.start({ text: '派给 Codex', turnId: 't1' })
  await tasks('plan', { goal: '功能合并派给 Codex', tasks: [{ title: '写目标书' }, { title: '发车 stage 3' }] })
  await clock.advance(30000)
  await tasks('done', { id: 1 })
  await $.tool.call({ tool: 'Bash', command: 'codex exec stage3', description: 'Codex stage 3', run_in_background: true } as never)
  await tasks('done', { id: 2 })
  await stop(1)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  let r = await row()
  expect(r).not.toContain('完成')
  expect(r).toContain('后台 1 个任务在跑')
  // the background work counts as a step of its own: 2 of 3, not 2/2 · 100% (neo-mate, 2026-10-09)
  expect(r).toContain('2/3 · 67%')
  expect(r).toContain('后台 · Codex stage 3')
  // the build ends and wakes a turn; nothing left in the background: now it is finished
  await clock.advance(600000)
  await $.turn.start({ text: '', turnId: 't2' })
  await stop(0)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't2' })
  r = await row()
  expect(r).toContain('完成')
  expect(r).not.toContain('在跑')
})

test('background work the plan started is a step of its own: on the row, in the card, in the file other chats read', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const card = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const imgs = await rowImgs(ui)
    await ui.unmount()
    return { row: String(imgs[0]!.props!.alt), card: String(imgs.at(-1)!.props!.source) }
  }
  const server = { id: 'srv', type: 'shell', status: 'running', description: '在 57611 端口起工作台', command: 'python cli.py dashboard --port 57611' }
  const old = { id: 'old', type: 'shell', status: 'running', description: '上一个计划留下的服务器', command: 'npm run dev' }
  const stop = (list: object[]) => $.classic.Stop({ stop_hook_active: false, background_tasks: list } as never)
  // an earlier turn left a dev server on, before this plan began
  await clock.advance(60000)
  await $.turn.start({ text: '先起个服务', turnId: 't0' })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: '上一个计划留下的服务器', run_in_background: true } as never)
  await stop([old])
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't0' })
  // what neo-mate did (2026-10-09 08:42–08:45): plan three steps, start a dashboard in the background
  // to reproduce the bug, mark all three done, hand the fix over, leave the dashboard running
  await clock.advance(60000)
  await $.turn.start({ text: '修事项详情面板', turnId: 't1' })
  await tasks('plan', { goal: '修事项详情面板', tasks: [{ title: '复现', minutes: 5 }, { title: '读代码', minutes: 10 }, { title: '出改法', minutes: 5 }] })
  await clock.advance(20000)
  await $.tool.call({ tool: 'Bash', command: server.command, description: server.description, run_in_background: true } as never)
  await clock.advance(120000)
  await tasks('done', { ids: [1, 2, 3] })
  await clock.advance(10000)
  await stop([old, server])
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  let v = await card()
  // 3 steps done and the plan's one server still up: 3/4 · 75%, never 100%; the old server is not the plan's
  expect(v.row).toContain('3/4 · 75%')
  expect(v.row).not.toContain('完成')
  expect(v.card).toContain('后台 · 在 57611 端口起工作台')
  // the old server is listed last, outside the plan, and not counted
  expect(v.card).toContain('计划外 · 上一个计划留下的服务器')
  // its clock runs from the call that launched it (2m 10s ago), not from when the turn stopped
  expect(v.card).toContain('2m 10s')
  // the server is stopped; the turn it wakes ends with only the old one left: the plan is finished
  await clock.advance(60000)
  await $.turn.start({ text: '', turnId: 't2' })
  await stop([old])
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't2' })
  v = await card()
  expect(v.row).toContain('完成')
})

test('with no plan, hovering lists the turn\'s latest operations with their times', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on)
  const card = async (surface: 'desktop' | 'terminal') => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface, ...BAND })
    const out = surface === 'desktop'
      ? String((await rowImgs(ui)).at(-1)?.props?.source ?? '')
      : JSON.stringify(await ui.find({ type: 'Box', key: 'goal-row' }) ?? null)
    await ui.unmount()
    return out
  }
  await clock.advance(60000)
  await $.turn.start({ text: '/handoff', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git log', description: 'Measuring journal loss' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/home/me/project/HANDOFF.md' } as never)
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'show' } as never) // the mod's own call is not an operation
  const desk = await card('desktop')
  expect(desk).toContain('Measuring journal loss')
  expect(desk).toContain('读 HANDOFF.md')
  expect(desk).not.toContain('tasks')
  expect(desk).toMatch(/\d+s</)
  expect(await card('terminal')).toContain('读 HANDOFF.md')
  // still there to look back on once the turn ends; a new turn starts a fresh list
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(await card('desktop')).toContain('读 HANDOFF.md')
  await $.turn.start({ text: '下一个', turnId: 't2' })
  expect(await card('desktop')).not.toContain('读 HANDOFF.md')
})

test('a finished row says when it finished, so an old 完成 is not read as a fresh one', async ($, on) => {
  const H = 3600000
  expect(ago(0, 30000)).toBe('刚刚')
  expect(ago(0, 5 * 60000)).toBe('5 分钟前')
  expect(ago(0, 2 * H)).toBe('2 小时前')
  expect(ago(new Date(2026, 9, 5, 9).getTime(), new Date(2026, 9, 7, 9).getTime())).toBe('10月5日')
  expect(rowOf(goal({ status: 'met', endedAt: 10 * 60000 }), prog, 0, null, null, 10 * 60000 + 2 * H)!.detail).toBe('用时 10m · 2 小时前')
  expect(rowOf(null, null, 0, null, { calls: 3, ms: 60000, at: 1000 }, 1000 + 5 * 60000)!.detail).toBe('3 个操作 · 用时 1m · 5 分钟前')
  // in the app: finish a plan, come back two hours later
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const clock = mock.clock(on)
  const row = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'terminal', ...BAND })
    const text = JSON.stringify(await ui.find({ type: 'Box' }))
    await ui.unmount()
    return text
  }
  await clock.advance(60000)
  await $.turn.start({ text: '做', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal: '小活', tasks: [{ title: '一步', size: 'S' }] } as never)
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'done', id: 1 } as never)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(await row()).toContain('刚刚')
  await clock.advance(2 * H)
  expect(await row()).toContain('2 小时前')
})

test('the running step shows its clock alone, no 进行中', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  const clock = mock.clock(on)
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal: '计时', tasks: [{ title: '甲', size: 'S' }] } as never)
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'start', id: 1 } as never)
  await clock.advance(39000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface, ...BAND })
    const all = JSON.stringify(await ui.find({ type: 'Box' }))
    await ui.unmount()
    expect(all).toContain('39s')
    expect(all).not.toContain('进行中')
  }
})

test('on the desktop, other chats show as a small area after the row, its own card listing their plans', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('ui.open', () => ({ value: undefined }))
  on('session.surface', () => ({ value: 'desktop' }))
  on('command.run', () => ({}))
  const clock = mock.clock(on)
  const t0 = 50 * 60000
  await clock.advance(t0)
  // two other chats wrote their goal files: one running in a worktree of neo-fitness, one done
  const files: Record<string, unknown> = {
    'aaa.json': (() => {
      const g = newGoal({ sessionId: 'aaa', condition: '倾斜提示', now: t0 - 20 * 60000, cwd: '/Users/me/neo-fitness/.claude/worktrees/card-c6b576' })
      applyAction(g, { action: 'plan', tasks: [{ title: '读代码', minutes: 10 }, { title: '实现', minutes: 30 }] }, { now: t0 - 20 * 60000 })
      applyAction(g, { action: 'done', id: 1 }, { now: t0 - 5 * 60000 })
      return { ...g, label: 'card-c6b576' }
    })(),
    // a chat whose steps are all done while the dashboard it started still runs (its file carries bg)
    'ccc.json': (() => {
      const g = newGoal({ sessionId: 'ccc', condition: '修事项详情面板', now: t0 - 10 * 60000, cwd: '/Users/me/neo-mate' })
      applyAction(g, { action: 'plan', tasks: [{ title: '复现', minutes: 5 }, { title: '出改法', minutes: 5 }] }, { now: t0 - 10 * 60000 })
      applyAction(g, { action: 'done', ids: [1, 2] }, { now: t0 - 5 * 60000 })
      return { ...g, bg: [{ id: 'srv', title: '起工作台', status: 'running', startedAt: t0 - 8 * 60000, step: 1, own: true }] }
    })(),
    'bbb.json': { sessionId: 'bbb', cwd: '/Users/me/memory-vault', label: 'memory-vault', title: 'Anna 常驻', status: 'met', startedAt: t0 - 30 * 60000, endedAt: t0 - 60000, planned: true, updatedAt: t0, tasks: [{ id: 1, title: '装', status: 'done' }] },
  }
  on('fs.list', () => ({ value: Object.keys(files).map((name) => ({ kind: 'file', name, mtimeMs: t0 })) }))
  on('fs.read', (_$, e) => {
    const name = String((e as { path: string }).path).split('/').pop()!
    if (!(name in files)) throw new Error('no such file')
    return { value: JSON.stringify(files[name]) }
  })
  await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal: '这个对话的活', tasks: [{ title: '读代码' }, { title: '改样式' }] })
  await $.command.run({ command: 'goals', args: '' } as never)
  const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
  const area = await ui.find({ type: 'Box', key: 'goal-others' })
  expect(area).toBeDefined()
  const inArea = JSON.stringify(area)
  expect(inArea).toContain('其他对话 3')
  expect(inArea).toContain('2 在跑')
  // the chat with only its background work left: 2 of 3 and 后台在跑, not 2/2 and done
  expect(inArea).toContain('2/3')
  expect(inArea).toContain('后台在跑')
  // the card: the project, not the worktree's folder; time left for the running one, 完成 for the done one
  expect(inArea).toContain('neo-fitness')
  expect(inArea).not.toContain('card-c6b576')
  expect(inArea).toContain('倾斜提示')
  expect(inArea).toContain('剩约')
  expect(inArea).toContain('完成 ✓')
  expect(inArea).toContain('"display":"none"')
  // the area is a frame wide and flush with the line's right end, so its card, hung from the area's
  // left edge, ends at the line's right end (別伸出行外); it comes first, the row over its blank part
  expect((area as Node).props!.right).toBe(0)
  expect(svgsIn(area)[0]!.props!.width).toBe(FRAME.w)
  const line = (await ui.findAll({ type: 'Svg' }))[0]!
  expect(line.props.width).toBe(LINE.w)
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn.indexOf('goal-others')).toBeLessThan(drawn.indexOf('goal-row'))
  // the row keeps its own card, and only its own
  const row = JSON.stringify(await ui.find({ type: 'Box', key: 'goal-row' }))
  expect(row).toContain('改样式')
  expect(row).not.toContain('neo-fitness')
  const alts = (await ui.findAll({ type: 'Svg' })).every((i) => String(i.props.alt).trim() !== '')
  expect(alts).toBe(true)
  await ui.unmount()
  // the terminal keeps its one row
  const term = await $.ui.mount({ plugin: 'goal-meter', surface: 'terminal', ...BAND })
  expect(await term.find({ type: 'Box', key: 'goal-others' })).toBeUndefined()
  await term.unmount()
})

test('background work still inside the step that started it is set under that step, listed and not counted twice', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  // the chat's log: a test run launched in the background before an update reloaded the mod
  let log = ''
  // read with grep, never whole: logs pass $.fs.read's 4 MiB cap (neo-mate's was 7 MB)
  on('fs.read', () => { throw new Error('no such file') })
  on('process.run', grepLog(() => log))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const view = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const imgs = await rowImgs(ui)
    await ui.unmount()
    return { row: String(imgs[0]!.props!.alt), card: String(imgs.at(-1)!.props!.source) }
  }
  const review = { id: 'cx', type: 'shell', status: 'running', description: 'Codex 外审', command: 'codex exec review < /dev/null' }
  const tests = { id: 'ui7', type: 'shell', status: 'running', description: '重跑界面测试', command: 'python -m pytest docs/acceptance' }
  const stray = { id: 'zz9', type: 'shell', status: 'running', description: '来源不明', command: 'sleep 9999' }
  const stop = (list: object[]) => $.classic.Stop({ stop_hook_active: false, transcript_path: '/tmp/chat.jsonl', background_tasks: list } as never)
  // what the skills chat did (2026-10-09): its step "Codex 外审一轮" runs the review in the background
  await clock.advance(60000)
  await $.turn.start({ text: '外审', turnId: 't1' })
  await tasks('plan', { goal: '合并插件', tasks: [{ title: '改代码', minutes: 5 }, { title: 'Codex 外审一轮', minutes: 30 }, { title: '发版', minutes: 5 }] })
  await clock.advance(60000)
  await tasks('done', { id: 1 })
  await $.tool.call({ tool: 'Bash', command: review.command, description: review.description, run_in_background: true } as never)
  await clock.advance(5000)
  // and, like neo-mate the same day, a second job in parallel under the same step, launched before
  // an update reloaded the mod: the log alone has it
  const at = 125000 // the mock clock starts at 0: 60s + 60s + 5s in
  log = [JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_result', content: 'Command running in background with ID: ui7. Output is being written to …' }] } })].join('\n')
  await stop([review, tests, stray])
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  let v = await view()
  // the step's ▶ and clock stand for its work: 1/3, and both jobs are listed under it, not as steps
  expect(v.row).toContain('1/3')
  expect(v.card).not.toContain('后台 ·')
  expect(v.card).toContain('↳')
  expect(v.card).toContain('Codex 外审<')
  expect(v.card).toContain('重跑界面测试')
  // the one no record knows is listed outside the plan, never counted
  expect(v.card).toContain('计划外 · 来源不明')
  // step 2 is marked done while both jobs still run and step 3 starts: they go under step 3, the step
  // running now (neo-mate, 2026-10-09: a test run launched eight seconds before the move read as a
  // step of its own, 3/7)
  await clock.advance(60000)
  await $.turn.start({ text: '', turnId: 't2' })
  await tasks('done', { id: 2 })
  await stop([review, tests, stray])
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't2' })
  v = await view()
  expect(v.row).toContain('2/3')
  expect(v.card).not.toContain('后台 ·')
  expect(v.card).toContain('↳')
  // the review ends while step 3 runs: it was a step's work, gone from the card, never counted
  await clock.advance(60000)
  await $.turn.start({ text: '', turnId: 't3' })
  await stop([tests, stray])
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't3' })
  v = await view()
  expect(v.row).toContain('2/3')
  expect(v.card).not.toContain('Codex 外审<')
  // every step done and the test run still going: now it is a step of its own, 3/4
  await clock.advance(60000)
  await $.turn.start({ text: '', turnId: 't4' })
  await tasks('done', { id: 3 })
  await stop([tests, stray])
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't4' })
  v = await view()
  expect(v.row).toContain('3/4')
  expect(v.card).toContain('后台 · 重跑界面测试')
  expect(v.card).not.toContain('↳')
})

test('a background task filed under the plan before its start was known is put right once the log shows it', () => {
  // neo-mate's plan file after 1.8.22 (2026-10-09): a server from an earlier plan, taken for new
  // across an update and filed under the running step
  const g = { startedAt: 1000, status: 'running', tasks: [{ id: 1, status: 'done', size: 'S' }, { id: 2, status: 'done', size: 'S' }], bg: [{ id: 'srv', title: '起工作台', status: 'running', startedAt: 1500, step: 2 }] } as never
  expect(foldBackground(g, [{ id: 'srv', type: 'shell', status: 'running', description: '起工作台' }], new Map([['srv', { at: 400, step: 0 }]]), 2000)).toBe(0)
  expect((g as { bg: { outside?: boolean }[] }).bg[0]!.outside).toBe(true)
  expect(shown(g).doneN + '/' + shown(g).n).toBe('2/2')
  // and a test run 1.8.21-1.8.25 made a step of its own though it ended while step 3 ran is step 3's
  const h = { startedAt: 1000, status: 'running', tasks: [{ id: 1, status: 'done', size: 'S', startedAt: 1000, doneAt: 1500 }, { id: 2, status: 'active', size: 'S', startedAt: 1500 }], bg: [{ id: 'run', title: '跑 12 组', status: 'done', startedAt: 1490, doneAt: 1800, step: 1, own: true }] } as never
  foldBackground(h, [], new Map(), 2000)
  expect(shown(h).doneN + '/' + shown(h).n).toBe('1/2')
})


test('after a reload the background work in the plan\'s file still counts: the step keeps ▶ and every clock runs', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  const clock = mock.clock(on)
  await clock.advance(10 * 60000)
  const t0 = 2 * 60000
  // neo-mate's plan file when 1.8.23 loaded (2026-10-09): step 2 running, its Codex job and a server
  // from an earlier plan both filed under it, both still running
  const g = newGoal({ sessionId: 's1', condition: '事项弹窗改造', now: t0, cwd: '/Users/me/neo-mate' })
  applyAction(g, { action: 'plan', tasks: [{ title: '写任务书', minutes: 1 }, { title: 'Codex 写代码并评审', minutes: 60 }, { title: '跑门禁', minutes: 10 }] }, { now: t0 })
  applyAction(g, { action: 'done', id: 1 }, { now: t0 + 2000 })
  // as in the real file: the turn had ended (active false), Claude waiting on the background work
  const file = { ...g, active: false, lastTurnEnd: t0 + 60000, updatedAt: t0 + 60000, bg: [
    { id: 'bee614n66', title: '用临时假数据库在 57611 端口起工作台', status: 'running', startedAt: t0 + 60000, step: 2 },
    { id: 'b3hydmlpi', title: '派 Codex 实现事项弹窗', status: 'running', startedAt: t0 + 60000, step: 2 },
  ] }
  const tr = (id: string, at: number) => JSON.stringify({ type: 'user', timestamp: new Date(at).toISOString(), message: { content: [{ type: 'tool_result', content: `Command running in background with ID: ${id}. Output …` }] } })
  const log = [tr('bee614n66', 30000), tr('b3hydmlpi', t0 + 3000)].join('\n')
  on('env.get', (_$, e) => ({ value: (e as { name: string }).name === 'HOME' ? '/home/me' : undefined }))
  on('session.start', (_$, e) => ({ ...(e as object) }))
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/Users/me/neo-mate' }))
  on('store.get', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: 'mcp__goal-meter__tasks' } }))
  on('command.register', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$, e) => {
    const path = String((e as { path: string }).path)
    if (path.endsWith('s1.json')) return { value: JSON.stringify(file) }
    throw new Error('no such file ' + path)
  })
  on('process.run', grepLog(() => log))
  await $.session.start({ cwd: '/Users/me/neo-mate', source: 'resume' } as never)
  const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
  const card = String((await rowImgs(ui)).at(-1)!.props!.source)
  await ui.unmount()
  // the Codex job counts again: step 2 reads ▶, not ⏸
  expect(card).toContain('▶')
  expect(card).not.toContain('⏸')
  // the server, launched before the plan (the log says so), is put outside it
  expect(card).toContain('计划外 · 用临时假数据库')
  expect(card).toContain('↳')
  // and the Codex job's clock runs from its real launch: 10m − 2m − 3s = 7m 57s
  expect(card).toContain('7m 57s')
})

test('the running step lists the background work that ended in it too, so its time adds up', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.Stop', () => ({}))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const sec = (n: number) => clock.advance(n * 1000)
  const launch = (id: string, description: string) => $.tool.call({ tool: 'Bash', command: 'run ' + id, description, run_in_background: true } as never)
  const job = (id: string, description: string) => ({ id, type: 'shell', status: 'running', description, command: 'run ' + id })
  const turn = async (n: string, running: object[], act: () => Promise<unknown> = async () => {}) => {
    await $.turn.start({ text: '', turnId: n })
    await act()
    await $.classic.Stop({ stop_hook_active: false, background_tasks: running } as never)
    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: n })
  }
  const card = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const src = String((await rowImgs(ui)).at(-1)!.props!.source)
    await ui.unmount()
    return [...src.matchAll(/>([^<>]+)</g)].map((m) => m[1]!.trim()).filter((x) => x && !x.includes('{'))
  }
  // neo-mate's 「UI 返修第二批」 (2026-10-09): step 3 runs the UI suite in the background, which ends 7s
  // after step 5 starts; the unit tests are launched 3s before step 5 and run 26m in it; then a rerun
  const ui3 = job('ui3', '第三次跑整套界面测试')
  const unit = job('unit', '后台跑全量单测')
  const rerun = job('rerun', '后台重跑全量单测')
  await sec(60)
  await turn('t1', [ui3], async () => {
    await tasks('plan', { goal: 'UI 返修第二批', tasks: [{ title: '整套界面测试 + 收尾', minutes: 30 }, { title: '全量检查、合并、装机', minutes: 30 }] })
    await launch('ui3', ui3.description)
  })
  await sec(700)
  await turn('t2', [ui3, unit], async () => {
    await launch('unit', unit.description)
    await sec(3)
    await tasks('done', { id: 1 })
  })
  await sec(7)
  await turn('t3', [unit])
  await sec(26 * 60)
  await turn('t4', [rerun], async () => { await launch('rerun', rerun.description) })
  await sec(15 * 60)
  const rows = await card()
  // step 2's own 41m 10s is its two runs, listed under it: the unit tests that ended (✓ 26m 10s) and the rerun (↳ 15m 00s)
  const at = (t: string) => rows.indexOf(t)
  expect(at('后台跑全量单测')).toBeGreaterThan(at('全量检查、合并、装机'))
  expect(rows[at('后台跑全量单测') - 1]).toBe('✓')
  expect(rows[at('后台跑全量单测') + 1]).toBe('26m 10s')
  expect(rows[at('后台重跑全量单测') - 1]).toBe('↳')
  expect(rows[at('后台重跑全量单测') + 1]).toBe('15m 00s')
  // the UI suite spent its time in step 1 and ended 7s into step 2: not listed under step 2
  expect(rows).not.toContain('第三次跑整套界面测试')
})
