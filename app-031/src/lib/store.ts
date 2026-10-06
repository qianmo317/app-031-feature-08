// 全局状态：Vue reactive 单例 + localStorage 持久化（无 Pinia/Vuex）
import { reactive, computed } from 'vue'
import type { Board, Job, NestResult, Part, RegisteredOffcut, SheetResult, Numbering, NumberingCfg } from '../types'
import { nestJob } from './packing'
import { rebuildFromPlacements } from './cuts'
import { guillotineViolation } from './geometry'
import { uid } from './format'
import {
  defaultCfg,
  planNumbering,
  numberingAudit,
  kernelFingerprint,
  validateCfg,
  type NumberingAudit
} from './numbering'
import boardsData from '../data/boards.json'

const JOBS_KEY = 'fco.jobs.v1'
const OFFCUTS_KEY = 'fco.offcuts.v1'

interface State {
  jobs: Job[]
  offcuts: RegisteredOffcut[]
  loaded: boolean
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T
    if (Array.isArray(fallback) && !Array.isArray(parsed)) return fallback
    return parsed
  } catch {
    return fallback
  }
}

const state = reactive<State>({
  jobs: [],
  offcuts: [],
  loaded: false
})

function persist(): void {
  localStorage.setItem(JOBS_KEY, JSON.stringify(state.jobs))
  localStorage.setItem(OFFCUTS_KEY, JSON.stringify(state.offcuts))
}

function init(): void {
  if (state.loaded) return
  state.jobs = load<Job[]>(JOBS_KEY, [])
  state.offcuts = load<RegisteredOffcut[]>(OFFCUTS_KEY, [])
  // 老档兼容：缺字段不能打不开；有排样结果却没有重排号的，按默认规则补一套并标明 migration
  for (const j of state.jobs) normalizeJob(j)
  state.loaded = true
}

/** 归一化一个项目：补齐所有后加字段；老项目缺柜体/编号方案时走兼容路径。 */
export function normalizeJob(obj: Partial<Job>): Job {
  const job = obj as Job
  job.useOffcutIds = Array.isArray(job.useOffcutIds) ? job.useOffcutIds : []
  job.batchByCabinet = typeof job.batchByCabinet === 'boolean' ? job.batchByCabinet : false
  if (!Array.isArray(job.boards)) job.boards = []
  if (!Array.isArray(job.parts)) job.parts = []
  for (const p of job.parts) {
    if (typeof p.cabinet !== 'string' || !p.cabinet) p.cabinet = '未分组'
  }
  if (job.numbering && validateJobNumbering(job.numbering)) {
    // 已有的重排号：校验覆盖；覆盖不全则不当新号用，整套管重新生成
    const ids = new Set((job.result?.sheets ?? []).flatMap((s) => s.placements.map((p) => p.instanceId)))
    const cover = job.numbering.tags.every((t) => ids.has(t.instanceId))
    const complete = [...ids].every((id) => job.numbering!.tags.some((t) => t.instanceId === id))
    if (!cover || !complete) job.numbering = undefined
  } else {
    job.numbering = undefined
  }
  if (!job.numbering && job.result?.sheets.length) {
    // 老号（placement.seq，摆上去的先后）绝不当新号用：按默认规则重排一套并标明
    job.numbering = buildNumbering(job, defaultCfg(), 'migration')
  }
  return job
}

function validateJobNumbering(n: Numbering): boolean {
  if (!n || typeof n !== 'object') return false
  if (validateCfg(n.cfg).length) return false
  if (!Array.isArray(n.tags)) return false
  return n.source === 'default' || n.source === 'user' || n.source === 'migration'
}

/** 由当前排样结果生成一套号（纯计算包装）。 */
function buildNumbering(job: Job, cfg: NumberingCfg, source: Numbering['source']): Numbering {
  const plan = planNumbering(job.result!.sheets, cfg)
  return { cfg: { ...cfg, digits: plan.effectiveDigits }, tags: plan.tags, source, appliedAt: Date.now() }
}

export function defaultBoards(): Board[] {
  return boardsData.stockBoards.slice(0, 3).map((b) => ({
    id: uid('b'),
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock'
  }))
}

export function allStockTemplates(): Omit<Board, 'id'>[] {
  return boardsData.stockBoards.map((b) => ({
    name: b.name,
    wMm: b.wMm,
    hMm: b.hMm,
    thicknessMm: b.thicknessMm,
    material: b.material,
    priceCents: b.priceCents,
    quantity: 0,
    kind: 'stock' as const
  }))
}

export function createJob(name: string): Job {
  init()
  const job: Job = {
    id: uid('job'),
    name: name.trim() || `开料项目 ${state.jobs.length + 1}`,
    createdAt: Date.now(),
    boards: defaultBoards(),
    parts: [],
    kerfMm: boardsData.defaults.kerfMm,
    trimMm: boardsData.defaults.trimMm,
    useOffcutIds: [],
    batchByCabinet: false
  }
  state.jobs.unshift(job)
  persist()
  return job
}

export function deleteJob(id: string): void {
  const i = state.jobs.findIndex((j) => j.id === id)
  if (i >= 0) state.jobs.splice(i, 1)
  persist()
}

export function duplicateJob(id: string): Job | null {
  const src = getJob(id)
  if (!src) return null
  const job: Job = JSON.parse(JSON.stringify(src))
  job.id = uid('job')
  job.name = `${src.name} 副本`
  job.createdAt = Date.now()
  job.result = undefined
  job.numbering = undefined
  normalizeJob(job)
  state.jobs.unshift(job)
  persist()
  return job
}

export function saveJob(_job: Job): void {
  persist()
}

export function getJob(id: string): Job | undefined {
  init()
  return state.jobs.find((j) => j.id === id)
}

/** 把勾选的登记余料转成本单可用的小板（排在板材列表前，优先消耗）。 */
function boardsWithOffcuts(job: Job): Board[] {
  const offcutBoards: Board[] = state.offcuts
    .filter((o) => o.available && job.useOffcutIds.includes(o.id))
    .map((o) => ({
      id: `offcut_${o.id}`,
      name: `余料板 ${o.wMm}×${o.hMm}×${o.thicknessMm}（${o.material}）`,
      wMm: o.wMm,
      hMm: o.hMm,
      thicknessMm: o.thicknessMm,
      material: o.material,
      priceCents: 0,
      quantity: 1,
      kind: 'offcut' as const,
      offcutId: o.id
    }))
  return [...offcutBoards, ...job.boards]
}

export function runNest(job: Job): NestResult {
  const effective: Job = { ...job, boards: boardsWithOffcuts(job) }
  const result = nestJob(effective)
  // 标记被用掉的余料
  const usedOffcutBoardIds = new Set(
    result.sheets.filter((s) => s.boardId.startsWith('offcut_')).map((s) => s.boardId)
  )
  for (const oc of state.offcuts) {
    if (usedOffcutBoardIds.has(`offcut_${oc.id}`)) {
      oc.available = false
      oc.usedByJobId = job.id
    }
  }
  job.result = result
  // 排样结果变了：重排号基于「件」(instanceId)，新结果里实例全部是新的，
  // 旧号必然覆盖不上，按既有方案重发一套；没有方案就用默认规则。
  // 注意：这不是「重排」，号随排样结果重新生成，source 取 default。
  if (result.sheets.length) {
    const cfg = job.numbering?.cfg ?? defaultCfg()
    job.numbering = buildNumbering(job, cfg, 'default')
  } else {
    job.numbering = undefined
  }
  persist()
  return result
}

export interface ApplyRenumberResult {
  ok: boolean
  audit: NumberingAudit | null
  errors: string[]
  plan: ReturnType<typeof planNumbering> | null
  rolledBack: boolean
}

/**
 * 用户重排：一次写成（原子）。
 * - 写前快照整份项目；写完逐刀审计（模拟 + 出处核对 + 六处覆盖 + 存储往返），
 *   任何拦截性问题都回退到快照，不留半套号。
 * - 摆法/刀路指纹前后必须一致，否则同样回退（内核不许跟着动）。
 * - 重复点：直接覆盖 numbering（前缀来自输入框而非叠加），不会接两遍。
 */
export function applyRenumber(job: Job, cfg: NumberingCfg): ApplyRenumberResult {
  const errors = validateCfg(cfg)
  if (!job.result) return { ok: false, audit: null, errors: [...errors, '该项目还没有排样结果'], plan: null, rolledBack: false }
  if (errors.length) return { ok: false, audit: null, errors, plan: null, rolledBack: false }

  const snapshot = JSON.stringify(job)
  const beforeKernel = kernelFingerprint(job)
  try {
    const plan = planNumbering(job.result.sheets, cfg)
    job.numbering = {
      cfg: { ...cfg, digits: plan.effectiveDigits },
      tags: plan.tags,
      source: 'user',
      appliedAt: Date.now()
    }
    const afterKernel = kernelFingerprint(job)
    if (afterKernel !== beforeKernel) {
      throw new Error('重排导致摆法或刀路发生变化（内核被改动），已回退')
    }
    const audit = numberingAudit(job)
    // 存储往返校验
    const roundtrip = JSON.parse(JSON.stringify(job)) as Job
    if (JSON.stringify(roundtrip.numbering) !== JSON.stringify(job.numbering)) {
      throw new Error('重排号无法完整写入本机存储，已回退')
    }
    if (!audit.ok) {
      throw new Error(audit.issues.map((i) => i.message).join('；'))
    }
    persist()
    return { ok: true, audit, errors: [], plan, rolledBack: false }
  } catch (e) {
    const restored = JSON.parse(snapshot) as Job
    Object.assign(job, restored)
    const msg = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      audit: null,
      errors: [`写入一半失败，已整份回退：${msg}`],
      plan: null,
      rolledBack: true
    }
  }
}

/** 手工微调：移动/交换后重新校验 guillotine 并重算刀路；非法返回错误信息。 */
export function applyAdjustment(
  job: Job,
  sheetIndex: number,
  placements: SheetResult['placements']
): string | null {
  if (!job.result) return '尚未排样'
  const sheet = job.result.sheets[sheetIndex]
  const bounds = {
    x: job.trimMm,
    y: job.trimMm,
    w: sheet.wMm - 2 * job.trimMm,
    h: sheet.hMm - 2 * job.trimMm
  }
  const violation = guillotineViolation(
    placements.map((p) => ({ id: p.instanceId, x: p.x, y: p.y, w: p.lenMm, h: p.widMm })),
    bounds,
    job.kerfMm
  )
  if (violation) return violation
  const rebuilt = rebuildFromPlacements(
    sheet.wMm,
    sheet.hMm,
    job.kerfMm,
    job.trimMm,
    sheetIndex,
    placements
  )
  if (!rebuilt) return '调整后无法生成可执行的贯通裁切刀路'
  const offcuts = rebuilt.leftovers
    .filter((r) => r.w >= 300 - 0.05 && r.h >= 300 - 0.05)
    .map((r) => ({
      x: Math.round(r.x),
      y: Math.round(r.y),
      wMm: Math.round(r.w),
      hMm: Math.round(r.h),
      areaMm2: Math.round(r.w * r.h),
      usable: true
    }))
    .sort((a, b) => b.areaMm2 - a.areaMm2)
  sheet.placements = placements.map((p) => ({ ...p, adjusted: true }))
  sheet.steps = rebuilt.steps
  sheet.offcuts = offcuts
  sheet.adjusted = true
  sheet.usedAreaMm2 = sheet.placements.reduce((a, p) => a + p.origLen * p.origWid, 0)
  sheet.utilization = sheet.usedAreaMm2 / sheet.boardAreaMm2
  persist()
  return null
}

export function registerOffcuts(
  job: Job,
  picks: { sheetIndex: number; x: number; y: number; wMm: number; hMm: number }[]
): number {
  if (!job.result) return 0
  let n = 0
  for (const pick of picks) {
    const sheet = job.result.sheets[pick.sheetIndex]
    state.offcuts.push({
      id: uid('oc'),
      jobId: job.id,
      jobName: job.name,
      sheetIndex: pick.sheetIndex,
      wMm: pick.wMm,
      hMm: pick.hMm,
      thicknessMm: sheet.thicknessMm,
      material: sheet.material,
      createdAt: Date.now(),
      available: true
    })
    n++
  }
  persist()
  return n
}

export function addManualOffcut(input: {
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
}): void {
  state.offcuts.push({
    id: uid('oc'),
    jobId: '',
    jobName: '手工登记',
    sheetIndex: -1,
    wMm: input.wMm,
    hMm: input.hMm,
    thicknessMm: input.thicknessMm,
    material: input.material,
    createdAt: Date.now(),
    available: true
  })
  persist()
}

export function removeOffcut(id: string): void {
  const i = state.offcuts.findIndex((o) => o.id === id)
  if (i >= 0) state.offcuts.splice(i, 1)
  persist()
}

export function toggleOffcut(id: string): void {
  const o = state.offcuts.find((x) => x.id === id)
  if (o) {
    o.available = !o.available
    if (o.available) o.usedByJobId = undefined
    persist()
  }
}

/** 示例：一套橱柜 + 衣柜混合 BOM（含竖纹门板、见光侧板、背板 9mm） */
export function createSampleJob(): Job {
  const job = createJob('示例：三室全屋柜体（18mm 柜体 + 9mm 背板）')
  const b18 = job.boards[0] // 颗粒板 18mm
  const bBack = boardsData.stockBoards[6]
  const back: Board = {
    id: uid('b'),
    name: bBack.name,
    wMm: bBack.wMm,
    hMm: bBack.hMm,
    thicknessMm: bBack.thicknessMm,
    material: bBack.material,
    priceCents: bBack.priceCents,
    quantity: 0,
    kind: 'stock'
  }
  job.boards.push(back)
  const P = (
    code: string,
    name: string,
    l: number,
    w: number,
    qty: number,
    grain: Part['grain'],
    edges: Part['edgeBands'],
    cabinet: string,
    exposed: boolean,
    boardId?: string
  ): Part => ({
    id: uid('p'),
    code,
    name,
    lenMm: l,
    widMm: w,
    qty,
    grain,
    edgeBands: edges,
    cabinet,
    exposed,
    boardId: boardId ?? b18.id
  })
  const all4: Part['edgeBands'] = ['top', 'bottom', 'left', 'right']
  const lb: Part['edgeBands'] = ['left', 'right']
  const tb: Part['edgeBands'] = ['top', 'bottom']
  job.parts = [
    // 地柜（600 宽标准柜 ×2 + 800 宽水槽柜）
    P('DC-S', '地柜侧板', 700, 560, 4, 'length', lb, '地柜', false),
    P('DC-D', '地柜底板', 564, 560, 2, 'none', tb, '地柜', false),
    P('DC-T', '地柜顶板/拉带', 564, 100, 2, 'none', [], '地柜', false),
    P('DC-M', '地柜门(竖纹见光)', 700, 296, 2, 'length', all4, '地柜', true),
    P('SC-S', '水槽柜侧板', 700, 560, 2, 'length', lb, '水槽柜', false),
    P('SC-D', '水槽柜底板', 764, 560, 1, 'none', tb, '水槽柜', false),
    P('SC-M', '水槽柜门(竖纹见光)', 700, 396, 2, 'length', all4, '水槽柜', true),
    // 吊柜
    P('GC-S', '吊柜侧板', 700, 320, 4, 'length', lb, '吊柜', false),
    P('GC-P', '吊柜层板', 764, 320, 2, 'none', tb, '吊柜', false),
    P('GC-M', '吊柜门板(竖纹见光)', 700, 396, 2, 'length', all4, '吊柜', true),
    // 衣柜
    P('WR-S', '衣柜见光侧板', 2200, 580, 2, 'length', all4, '衣柜', true),
    P('WR-IS', '衣柜中侧板', 2180, 560, 1, 'length', lb, '衣柜', false),
    P('WR-P', '衣柜层板', 564, 560, 5, 'none', tb, '衣柜', false),
    P('WR-T', '衣柜顶板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-B', '衣柜底板', 1800, 560, 1, 'none', tb, '衣柜', false),
    P('WR-M', '衣柜门板(竖纹见光)', 2180, 446, 4, 'length', all4, '衣柜', true),
    // 9mm 背板（指定板材）
    P('BB-D', '地柜/水槽柜背板', 690, 564, 3, 'none', [], '地柜', false, back.id),
    P('BB-G', '吊柜背板', 690, 764, 1, 'none', [], '吊柜', false, back.id),
    P('BB-W', '衣柜背板(竖纹)', 2180, 900, 2, 'length', [], '衣柜', false, back.id)
  ]
  return job
}

export function newPart(partial: Partial<Part> = {}): Part {
  return {
    id: uid('p'),
    code: partial.code ?? '',
    name: partial.name ?? '',
    lenMm: partial.lenMm ?? 0,
    widMm: partial.widMm ?? 0,
    qty: partial.qty ?? 1,
    grain: partial.grain ?? 'none',
    edgeBands: partial.edgeBands ?? [],
    cabinet: partial.cabinet ?? '未分组',
    exposed: partial.exposed ?? false,
    boardId: partial.boardId ?? ''
  }
}

export function exportJobJson(job: Job): string {
  return JSON.stringify(job, null, 2)
}

export function importJobJson(json: string): Job | null {
  try {
    const obj = JSON.parse(json) as Partial<Job>
    if (!obj.parts || !obj.boards) return null
    obj.id = uid('job')
    obj.createdAt = Date.now()
    // 导入的排样结果是在原机器/原版本下产生的，号不作为新号带入，重新排样后再给默认号
    obj.result = undefined
    obj.numbering = undefined
    const job = normalizeJob(obj)
    state.jobs.unshift(job)
    persist()
    return job
  } catch {
    return null
  }
}

export function useStore() {
  init()
  return {
    state,
    jobs: computed(() => state.jobs),
    offcuts: computed(() => state.offcuts)
  }
}

export { boardsData }
