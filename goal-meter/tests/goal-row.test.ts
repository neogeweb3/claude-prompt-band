import { expect, mock, test } from 'claude-code/testing'

import { CARD, FRAME, SCALE, ago, cropSvg, rowOf, rowSpans, rowSvg, stepsSvg, textW } from '../hooks/row.mjs'

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
  expect(rowOf(goal({ title: '核对 10-05 的数据丢失，并找出删文件的那条路径' }), prog, 0)!.title).toBe('核对 10-05 的数据丢失，并找出删文件的那条路径')
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
      // and whose frame is always FRAME.w wide (renderer source, 2026-10-07). So the keyed Box
      // holds the row drawn exactly FRAME.w wide, centred in the band, and the card fills the
      // frame unscaled. A short row is padded with blank room inside that one image.
      const imgs = await ui.findAll({ type: 'Svg' })
      expect(imgs).toHaveLength(2) // the row, the card
      expect(imgs[0]!.props.width).toBe(FRAME.w)
      expect(String(imgs[0]!.props.source)).toMatch(/viewBox="-[\d.]+ 0 360 30"/)
      expect(imgs[1]!.props.width).toBe(FRAME.w - FRAME.pad * 2)
      expect(String(imgs[1]!.props.source)).toContain('改样式')
      expect(hidden).not.toContain('goal-card-anchor')
    }
    expect(await ui.find({ type: 'Text', text: /^S\b|^L\b/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('on the desktop the card sits centred over a row of any width, and every image has an alt', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  mock.clock(on)
  // 1.8.1's centring strip had alt '' and the desktop dropped it: an alt must hold a non-blank
  const alts = (imgs: { props: Record<string, unknown> }[]) => imgs.every((i) => String(i.props.alt).trim() !== '')
  for (const title of ['短', '一个很长很长的任务名字，长到整行远比卡片的外框还要宽出一大截']) {
    await $.tool.call({ tool: 'mcp__goal-meter__tasks', action: 'plan', goal: title, tasks: [{ title: '读代码' }, { title: '改样式' }] })
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const imgs = await ui.findAll({ type: 'Svg' })
    expect(alts(imgs)).toBe(true)
    const scope = await ui.find({ type: 'Box', key: 'goal-row' })
    const inScope = JSON.stringify(scope)
    // the hover's own image is FRAME.w wide whatever the row; the card fills the frame
    const anchor = imgs.find((i) => i.props.width === FRAME.w)!
    expect(inScope).toContain(JSON.stringify(anchor.props.source))
    const pieces = imgs.filter((i) => !String(i.props.source).includes('改样式'))
    const total = pieces.reduce((a, i) => a + (i.props.width as number), 0)
    if (title === '短') {
      expect(pieces).toHaveLength(1)
    } else {
      // a wide row: the parts beyond the frame are two more pieces, left and right, outside the
      // hover, together exactly the row; the frame's middle is the row's middle within half a px
      expect(pieces).toHaveLength(3)
      expect(pieces[1]).toBe(anchor)
      expect(total).toBeGreaterThan(FRAME.w)
      const left = pieces[0]!.props.width as number
      expect(Math.abs(left + FRAME.w / 2 - total / 2)).toBeLessThanOrEqual(0.5)
      expect(inScope).not.toContain(JSON.stringify(pieces[0]!.props.source))
    }
    await ui.unmount()
  }
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
  const imgs = await ui.findAll({ type: 'Svg' })
  await ui.unmount()
  expect(String(imgs[0]!.props.source)).toContain('美化进度行')
  expect(String(imgs[0]!.props.source)).not.toContain('显示当前步骤')
  expect(String(imgs.at(-1)!.props.source)).toContain('显示当前步骤')
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
    const s = String((await ui.find({ type: 'Svg' }))!.props.source)
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

test('every finished step shows a time, even one marked done without a start', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  await clock.advance(60000)
  await tasks('plan', { goal: '计时', tasks: [{ title: '甲', size: 'S' }, { title: '乙', size: 'S' }, { title: '丙', size: 'S' }] })
  await clock.advance(3 * 60000)
  await tasks('done', { id: 1 }) // never started: timed from the plan's start
  await clock.advance(10000)
  await tasks('done', { ids: [2, 3] }) // a batch: the second had no time of its own
  const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
  const card = String((await ui.findAll({ type: 'Svg' })).at(-1)!.props.source)
  await ui.unmount()
  const tails = [...card.matchAll(/text-anchor="end" class="mute">([^<]*)</g)].map(m => m[1])
  expect(tails).toEqual(['3m 00s', '10s', '0s'])
})

test('a step worked on without being marked started still shows its clock, by the second', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => $.ui.resolve(e).Box({ children: [] }))
  on('tool.call', () => ({ result: 'engine' }))
  const clock = mock.clock(on)
  const tasks = (action: string, extra = {}) => $.tool.call({ tool: 'mcp__goal-meter__tasks', action, ...extra } as never)
  const tails = async () => {
    const ui = await $.ui.mount({ plugin: 'goal-meter', surface: 'desktop', ...BAND })
    const card = String((await ui.findAll({ type: 'Svg' })).at(-1)!.props.source)
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
    await ui.unmount()
    const card = String(imgs.at(-1)!.props.source)
    return { row: imgs.map((i) => String(i.props.alt)).join(' '), tails: [...card.matchAll(/text-anchor="end" class="mute">([^<]*)</g)].map(m => m[1]) }
  }
  const stop = (bg: number) => $.classic.Stop({ stop_hook_active: false, background_tasks: Array.from({ length: bg }, (_, i) => ({ id: 'b' + i, type: 'shell', status: 'running', description: 'x' })) } as never)
  await clock.advance(60000)
  await $.turn.start({ text: '做', turnId: 't1' })
  await tasks('plan', { goal: '收尾', tasks: [{ title: '甲' }, { title: '乙' }, { title: '丙' }, { title: '丁' }] })
  for (const id of [1, 2]) { await clock.advance(10000); await tasks('done', { id }) }
  await clock.advance(5000)
  // a background task is still carrying 丙 when the turn stops: its clock and the estimate go on
  await stop(1)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't1' })
  await clock.advance(33000)
  let v = await view()
  expect(v.tails).toEqual(['10s', '10s', '38s'])
  expect(v.row).toContain('剩约')
  // the background task woke a turn that ended with nothing left running: the work waits on the person
  await $.turn.start({ text: '', turnId: 't2' })
  await stop(0)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't2' })
  await clock.advance(60000)
  v = await view()
  expect(v.tails).toEqual(['10s', '10s'])
  expect(v.row).not.toContain('剩约')
  // a step marked under way stops where the work stopped, not counting on
  await $.turn.start({ text: '继续', turnId: 't3' })
  await tasks('start', { id: 3 })
  await clock.advance(7000)
  await stop(0)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, isAborted: false, turnId: 't3' })
  await clock.advance(120000)
  expect((await view()).tails).toEqual(['10s', '10s', '7s'])
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
      ? String((await ui.findAll({ type: 'Svg' })).at(-1)?.props.source ?? '')
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
