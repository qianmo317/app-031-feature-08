// 零件重排号：只生成「显示/打印用」的一套号，与排样内核（摆法、刀路）完全解耦。
// 规则：按柜体 + 件名重排，同一柜子的件连号；前缀、序号位数、每柜起号用户自定；
// 位数不够时绝不截断，按 continue / widen 两条路之一处理（后果由调用方写明给用户）。
import type {
  Job,
  NestResult,
  NumberingGroup,
  NumberingPlan,
  NumberingSpec,
  NumberingTag,
  Placement,
  SheetResult
} from '../types'
import { simulate } from './cuts'

export const DEFAULT_SPEC: NumberingSpec = {
  prefix: '',
  digits: 3,
  startAt: 1,
  overflow: 'continue'
}

const MAX_DIGITS = 6
const MAX_PREFIX = 12
const MAX_START = 999_999

/** 所有显示/打印号必须取自这里；取不到号返回空串（由一致性核对点名，绝不回退用老 seq）。 */
export function tagText(job: Job | undefined, instanceId: string): string {
  return job?.numbering?.tags[instanceId]?.full ?? ''
}

export function tagOf(plan: NumberingPlan | undefined, instanceId: string): NumberingTag | undefined {
  return plan?.tags[instanceId]
}

/** 规整并校验用户填的编号规则；规则不合法时返回错误（中文，可直接展示）。 */
export function normalizeSpec(input: Partial<NumberingSpec>): { spec: NumberingSpec; errors: string[] } {
  const errors: string[] = []
  const prefix = (input.prefix ?? '').trim()
  if (prefix.length > MAX_PREFIX) errors.push(`前缀最长 ${MAX_PREFIX} 个字符（当前 ${prefix.length} 个）`)
  const digits = Math.floor(Number(input.digits))
  if (!Number.isFinite(digits) || digits < 1 || digits > MAX_DIGITS)
    errors.push(`位数必须是 1 ~ ${MAX_DIGITS} 之间的整数`)
  const startAt = Math.floor(Number(input.startAt))
  if (!Number.isFinite(startAt) || startAt < 1 || startAt > MAX_START)
    errors.push(`每柜起号必须是 1 ~ ${MAX_START} 之间的整数`)
  const overflow: NumberingSpec['overflow'] =
    input.overflow === 'widen' ? 'widen' : input.overflow === 'continue' ? 'continue' : 'continue'
  return { spec: { prefix, digits: digits || DEFAULT_SPEC.digits, startAt: startAt || 1, overflow }, errors }
}

function digitsOf(n: number): number {
  return String(Math.max(0, Math.floor(n))).length
}

function padSerial(serial: number, width: number): string {
  return String(serial).padStart(width, '0')
}

/** 重排后的统一取件顺序：柜体 → 件名 → 编码 → 所在板 → 板上位置（下→上、左→右）→ 原始摆放序。 */
export function orderedInstances(result: NestResult): Placement[] {
  return result.sheets
    .flatMap((s) => s.placements)
    .map((p) => ({ p, key: sortKey(p) }))
    .sort((a, b) => cmpKey(a.key, b.key))
    .map((x) => x.p)
}

type SortKey = [string, string, string, number, number, number, number, string]
function sortKey(p: Placement): SortKey {
  return [p.cabinet, p.name, p.code, p.boardIndex, Math.round(p.y), Math.round(p.x), p.seq, p.instanceId]
}
function cmpKey(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i++) {
    const av = a[i]
    const bv = b[i]
    if (av === bv) continue
    if (typeof av === 'number' && typeof bv === 'number') return av - bv
    return String(av).localeCompare(String(bv), 'zh')
  }
  return 0
}

function joinTag(prefix: string, serialText: string): string {
  return prefix ? `${prefix}${serialText}` : serialText
}

/**
 * 一次写成地算出整批号（不读旧 plan、不做增量拼接 → 重复重排绝不会把前缀接两遍）。
 * continue：只有溢出的几件用全号接着往后排，其余件原样不动，柜内连号在断口处不再整齐。
 * widen：整批位数加宽到能容纳最大序号后全部重排，连号完整。
 */
export function buildNumbering(
  specIn: NumberingSpec,
  result: NestResult,
  source: NumberingPlan['source']
): NumberingPlan {
  let { spec, errors } = normalizeSpec(specIn)
  if (errors.length > 0) throw new Error(errors.join('；'))

  const ordered = orderedInstances(result)
  const maxSerialByCabinet = new Map<string, number>()
  for (const p of ordered) {
    const idx = (maxSerialByCabinet.get(p.cabinet) ?? 0) + 1
    maxSerialByCabinet.set(p.cabinet, idx)
  }
  const maxSerial = Math.max(0, ...[...maxSerialByCabinet.values()].map((c) => spec.startAt + c - 1))
  // widen：整批统一加宽（每个柜都重排，号长一致，连号完整）；位数本身改写为加宽值
  if (spec.overflow === 'widen' && digitsOf(maxSerial) > spec.digits) {
    spec = { ...spec, digits: digitsOf(maxSerial) }
  }
  const width = spec.digits

  const tags: Record<string, NumberingTag> = {}
  const counters = new Map<string, number>()
  const groupMap = new Map<string, NumberingGroup & { overflowIds: Set<string> }>()
  let totalOverflow = 0

  for (const p of ordered) {
    const indexInCabinet = (counters.get(p.cabinet) ?? 0) + 1
    counters.set(p.cabinet, indexInCabinet)
    const serial = spec.startAt + indexInCabinet - 1
    const overflow = digitsOf(serial) > spec.digits
    if (overflow) totalOverflow++
    // continue：溢出件不补零、整号写出（1000 而不是 000）；其余件仍按指定位数补零
    const serialText =
      overflow && spec.overflow === 'continue' ? String(serial) : padSerial(serial, width)
    tags[p.instanceId] = {
      full: joinTag(spec.prefix, serialText),
      cabinet: p.cabinet,
      indexInCabinet,
      serial,
      overflow
    }
    let g = groupMap.get(p.cabinet)
    if (!g) {
      g = {
        cabinet: p.cabinet,
        count: 0,
        firstSerial: serial,
        lastSerial: serial,
        overflowCount: 0,
        overflowIds: new Set<string>()
      }
      groupMap.set(p.cabinet, g)
    }
    g.count++
    g.lastSerial = serial
    if (overflow) {
      g.overflowCount++
      g.overflowIds.add(p.instanceId)
    }
  }

  const groups: NumberingGroup[] = [...groupMap.values()]
    .map(({ overflowIds: _ignored, ...g }) => g)
    .sort((a, b) => a.cabinet.localeCompare(b.cabinet, 'zh'))

  return { spec, tags, groups, totalOverflow, appliedAt: Date.now(), source }
}

/** 柜组在当前规格下的号段文字（标签上的完整起止号）。 */
export function groupRange(plan: NumberingPlan, g: NumberingGroup): string {
  const find = (serial: number): string => {
    const t = Object.values(plan.tags).find((x) => x.cabinet === g.cabinet && x.serial === serial)
    return t?.full ?? joinTag(plan.spec.prefix, padSerial(serial, plan.spec.digits))
  }
  if (g.count === 1) return find(g.firstSerial)
  return `${find(g.firstSerial)} ~ ${find(g.lastSerial)}`
}

/** 同件名聚到的连续号压缩成号段（下料单用）：A-001 ~ A-004。 */
export function compactTagRanges(
  plan: NumberingPlan,
  instances: { instanceId: string }[]
): string {
  const tags = instances
    .map((i) => plan.tags[i.instanceId])
    .filter((t): t is NumberingTag => !!t)
    .sort((a, b) => a.serial - b.serial)
  if (tags.length === 0) return ''
  const parts: string[] = []
  let runStart = tags[0]
  let runEnd = tags[0]
  const flush = (): void => {
    parts.push(runStart === runEnd ? runStart.full : `${runStart.full} ~ ${runEnd.full}`)
  }
  for (let i = 1; i < tags.length; i++) {
    const t = tags[i]
    if (t.serial === runEnd.serial + 1 && t.cabinet === runEnd.cabinet) {
      runEnd = t
    } else {
      flush()
      runStart = runEnd = t
    }
  }
  flush()
  return parts.join('，')
}

// ===== 一致性核对：一处换新必须处处换新；挂老号/撞号都点名 =====

export interface NumberingProblem {
  instanceId?: string
  code?: string
  name?: string
  cabinet?: string
  problem: string
  surfaces: string[] // 这个问题会让哪几处显示错号
}

export interface NumberingAudit {
  ok: boolean
  hasPlan: boolean
  source?: NumberingPlan['source']
  problems: NumberingProblem[]
  /** 明确指出还挂着老号的具体位置 */
  staleSurfaces: string[]
  totalOverflow: number
  groups: NumberingGroup[]
}

export const SURFACE_DIAGRAM = '结果页拼版图标注'
export const SURFACE_LABEL = '标签打印'
export const SURFACE_ORDER = '下料单与裁切步骤表'
export const SURFACE_STATS = '材料统计页按柜体件数'
export const SURFACE_STORAGE = '本机存储'
const PIECE_SURFACES = [SURFACE_DIAGRAM, SURFACE_LABEL, SURFACE_ORDER]

function placementsOf(job: Job): Placement[] {
  return job.result ? orderedInstances(job.result) : []
}

/**
 * 核对五处用号是否同一套：
 * 逐件号（图/标签/单据/步骤表）、按柜号段与件数（统计页）、本机存储。
 */
export function auditNumbering(job: Job): NumberingAudit {
  const problems: NumberingProblem[] = []
  const stale = new Set<string>()
  const plan = job.numbering
  if (!job.result || !plan) {
    return {
      ok: false,
      hasPlan: !!plan,
      source: plan?.source,
      problems: job.result
        ? [{ problem: '还没有重排号，各处仍会显示空号（旧项目应按默认规则补排）', surfaces: PIECE_SURFACES }]
        : [],
      staleSurfaces: [],
      totalOverflow: 0,
      groups: []
    }
  }

  const placements = placementsOf(job)
  const reference = buildNumbering(plan.spec, job.result, plan.source)

  // 1) 同一个件号在两处撞上（两个实例拿到同一 full）
  const fullToIds = new Map<string, string[]>()
  for (const [id, t] of Object.entries(plan.tags)) {
    const arr = fullToIds.get(t.full) ?? []
    arr.push(id)
    fullToIds.set(t.full, arr)
  }
  for (const [full, ids] of fullToIds) {
    if (ids.length > 1) {
      const ps = ids.map((id) => placements.find((p) => p.instanceId === id))
      problems.push({
        problem: `件号冲突：${full} 同时挂在 ${ids.length} 件上（${ps
          .map((p) => (p ? `${p.code}/${p.name}` : ids[0]))
          .join('、')}）`,
        surfaces: PIECE_SURFACES
      })
      PIECE_SURFACES.forEach((s) => stale.add(s))
    }
  }

  // 2) 每件都必须有号，且号必须等于按当前规则重算的号（不等 = 这一处挂着老号）
  for (const p of placements) {
    const stored = plan.tags[p.instanceId]
    const expected = reference.tags[p.instanceId]
    if (!stored) {
      problems.push({
        instanceId: p.instanceId,
        code: p.code,
        name: p.name,
        cabinet: p.cabinet,
        problem: `「${p.cabinet}」的 ${p.code}（${p.name}）没有件号`,
        surfaces: PIECE_SURFACES
      })
      PIECE_SURFACES.forEach((s) => stale.add(s))
    } else if (expected && stored.full !== expected.full) {
      problems.push({
        instanceId: p.instanceId,
        code: p.code,
        name: p.name,
        cabinet: p.cabinet,
        problem: `「${p.cabinet}」的 ${p.code}（${p.name}）挂着老号 ${stored.full}，当前规则应为 ${expected.full}`,
        surfaces: PIECE_SURFACES
      })
      PIECE_SURFACES.forEach((s) => stale.add(s))
    }
  }
  // 3) 存储里多出的号（对应已不存在的件）
  const liveIds = new Set(placements.map((p) => p.instanceId))
  for (const id of Object.keys(plan.tags)) {
    if (!liveIds.has(id)) {
      problems.push({ instanceId: id, problem: `存储中残留已不存在的件号 ${plan.tags[id].full}（${id}）`, surfaces: [SURFACE_STORAGE] })
      stale.add(SURFACE_STORAGE)
    }
  }

  // 4) 统计页：柜数、每柜件数、号段必须与逐件号派生一致
  const refGroupMap = new Map(reference.groups.map((g) => [g.cabinet, g]))
  for (const g of plan.groups) {
    const rg = refGroupMap.get(g.cabinet)
    if (!rg || rg.count !== g.count || rg.firstSerial !== g.firstSerial || rg.lastSerial !== g.lastSerial) {
      problems.push({
        cabinet: g.cabinet,
        problem: `材料统计中「${g.cabinet}」的件数/号段（${g.count} 件，${g.firstSerial}~${g.lastSerial}）与逐件号不一致`,
        surfaces: [SURFACE_STATS]
      })
      stale.add(SURFACE_STATS)
    }
  }
  if (plan.groups.length !== reference.groups.length) {
    problems.push({ problem: '材料统计的柜体分组数与实际件号不一致', surfaces: [SURFACE_STATS] })
    stale.add(SURFACE_STATS)
  }

  // 5) 本机存储：localStorage 里该项目的号必须与内存同一套
  try {
    const raw = localStorage.getItem('fco.jobs.v1')
    if (raw) {
      const jobs = JSON.parse(raw) as Job[]
      const stored = jobs.find((j) => j.id === job.id)
      const storedAt = stored?.numbering?.appliedAt
      if (!stored?.numbering || storedAt !== plan.appliedAt) {
        problems.push({ problem: '本机存储中的那套号不是当前这套（尚未保存或保存失败）', surfaces: [SURFACE_STORAGE] })
        stale.add(SURFACE_STORAGE)
      }
    }
  } catch {
    // 存储不可用时不阻断页面逻辑
  }

  return {
    ok: problems.length === 0,
    hasPlan: true,
    source: plan.source,
    problems,
    staleSurfaces: [...stale],
    totalOverflow: plan.totalOverflow,
    groups: plan.groups
  }
}

// ===== 按贯通切割顺序逐刀回看：每刀切出哪一件、这件的号对不对得上 =====

export interface ProducedPiece {
  instanceId: string
  code: string
  name: string
  cabinet: string
  full: string
  problem?: string
}
export interface CutReplayCut {
  sheetIndex: number
  order: number
  kind: 'trim' | 'cut'
  label: string
  produced: ProducedPiece[]
}
export interface CutReplayResult {
  ok: boolean
  cuts: CutReplayCut[]
  problems: string[]
}

interface Leaf {
  x: number
  y: number
  w: number
  h: number
}
const EPS = 0.05

/** 与 cuts.simulate 同一把尺子劈分，但在每一刀落完后记录「定型的是哪几件」。 */
function replaySheet(sheet: SheetResult, kerf: number, plan: NumberingPlan): CutReplayCut[] {
  let leaves: Leaf[] = [{ x: 0, y: 0, w: sheet.wMm, h: sheet.hMm }]
  const claimed = new Set<string>()
  const out: CutReplayCut[] = []
  const TOL = kerf + 0.6

  const matchPart = (lf: Leaf): Placement | undefined => {
    for (const p of sheet.placements) {
      if (claimed.has(p.instanceId)) continue
      if (
        Math.abs(lf.x - p.x) <= TOL &&
        Math.abs(lf.y - p.y) <= TOL &&
        Math.abs(lf.x + lf.w - (p.x + p.lenMm)) <= TOL &&
        Math.abs(lf.y + lf.h - (p.y + p.widMm)) <= TOL
      )
        return p
    }
    return undefined
  }

  for (const st of sheet.steps) {
    const next: Leaf[] = []
    for (const leaf of leaves) {
      const alongStart = st.axis === 'v' ? leaf.y : leaf.x
      const alongSize = st.axis === 'v' ? leaf.h : leaf.w
      const intersects = st.span[1] > alongStart + EPS && st.span[0] < alongStart + alongSize - EPS
      const across = st.axis === 'v' ? leaf.x : leaf.y
      const acrossSize = st.axis === 'v' ? leaf.w : leaf.h
      const canSplit = intersects && st.at > across + EPS && st.at < across + acrossSize - EPS
      if (!canSplit) {
        next.push(leaf)
        continue
      }
      if (st.axis === 'v') {
        const wl = st.at - kerf / 2 - leaf.x
        const wr = leaf.x + leaf.w - (st.at + kerf / 2)
        if (wl >= -EPS && wr >= -EPS) {
          next.push({ x: leaf.x, y: leaf.y, w: wl, h: leaf.h })
          next.push({ x: st.at + kerf / 2, y: leaf.y, w: wr, h: leaf.h })
        } else next.push(leaf)
      } else {
        const hb = st.at - kerf / 2 - leaf.y
        const ht = leaf.y + leaf.h - (st.at + kerf / 2)
        if (hb >= -EPS && ht >= -EPS) {
          next.push({ x: leaf.x, y: leaf.y, w: leaf.w, h: hb })
          next.push({ x: leaf.x, y: st.at + kerf / 2, w: leaf.w, h: ht })
        } else next.push(leaf)
      }
    }
    leaves = next

    const produced: ProducedPiece[] = []
    for (const lf of leaves) {
      const p = matchPart(lf)
      if (!p) continue
      claimed.add(p.instanceId)
      const t = plan.tags[p.instanceId]
      produced.push({
        instanceId: p.instanceId,
        code: p.code,
        name: p.name,
        cabinet: p.cabinet,
        full: t?.full ?? '',
        problem: !t
          ? `第 ${sheet.index + 1} 张第 ${st.order + 1} 刀切出的 ${p.code}（${p.name}）对不上任何件号`
          : undefined
      })
    }
    out.push({ sheetIndex: sheet.index, order: st.order, kind: st.kind, label: st.label, produced })
  }
  return out
}

/** 重排提交前的闸门：逐刀回看，任一件号对不上都不放行（由调用方回退整批）。 */
export function verifyCuts(job: Job, plan: NumberingPlan): CutReplayResult {
  const problems: string[] = []
  if (!job.result) return { ok: false, cuts: [], problems: ['尚未排样'] }
  const cuts: CutReplayCut[] = []
  for (const sheet of job.result.sheets) {
    cuts.push(...replaySheet(sheet, job.kerfMm, plan))
    // 刀路本身也必须仍然能还原全部零件（摆法/刀路没被编号改动碰过的底线）
    const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
    if (!sim.ok) problems.push(`第 ${sheet.index + 1} 张刀路模拟失败：${sim.errors.join('；')}`)
  }
  const produced = new Set<string>()
  for (const c of cuts) {
    for (const pc of c.produced) {
      if (produced.has(pc.instanceId))
        problems.push(`件 ${pc.code}（${pc.name}）被不同的刀重复切出，件号 ${pc.full || '（空）'} 无法对应`)
      produced.add(pc.instanceId)
      if (pc.problem) problems.push(pc.problem)
      else {
        const expected = buildNumbering(plan.spec, job.result, plan.source).tags[pc.instanceId]?.full
        if (expected && pc.full !== expected)
          problems.push(
            `「${pc.cabinet}」的 ${pc.code}（${pc.name}）刀路上挂的号是 ${pc.full}，按当前规则应为 ${expected}`
          )
      }
    }
  }
  for (const p of job.result.sheets.flatMap((s) => s.placements)) {
    if (!produced.has(p.instanceId))
      problems.push(`「${p.cabinet}」的 ${p.code}（${p.name}）逐刀回看时没有任何一刀把它切出来`)
  }
  return { ok: problems.length === 0, cuts, problems }
}

/** 供裁切步骤页/打印取用：每刀（含修边刀）切出的件与其当前件号。无编号时返回 null。 */
export function cutReplay(job: Job): CutReplayResult | null {
  if (!job.result || !job.numbering) return null
  return verifyCuts(job, job.numbering)
}
