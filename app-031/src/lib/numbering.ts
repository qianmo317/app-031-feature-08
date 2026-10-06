// 零件标签按柜体重排 —— 只改「显示与打印用的号」，排样内核（摆法/刀路）一律不动。
//
// 设计约定：
// - 全批按 柜体 → 件名 → 件号(partId, 第 k 件) 排序后连续给号，
//   因此同一柜体的件天然连号；号在全批内唯一，不会与别的柜撞号。
// - 位数不够只有两条路（OverflowPolicy），后果由调用方在 UI 上写明：
//   · continue：溢出件不补零、接着往后单独排，已贴标签/已发单据不动，
//     代价是该柜连号在溢出位置断开，不整齐。
//   · widen ：整批加宽位数重排，连号完整；代价是已经贴在件上的标签、
//     已发出去的下料单/裁切步骤表全部对不上号，必须整批作废重打
//     （返工成本落在车间：撕旧标签、换新单）。
import type {
  Job,
  Numbering,
  NumberingCfg,
  NumberingIssue,
  PartTag,
  Placement,
  SheetResult
} from '../types'
import { simulate } from './cuts'
import { EPS } from './geometry'

export const NUMBERING_SURFACES = [
  { key: 'nest', name: '结果页拼版图标注' },
  { key: 'labels', name: '标签打印' },
  { key: 'order', name: '下料单' },
  { key: 'cut', name: '裁切步骤表' },
  { key: 'stats', name: '材料统计（按柜体件数）' },
  { key: 'storage', name: '本机存储' }
] as const
export type SurfaceKey = (typeof NUMBERING_SURFACES)[number]['key']

export function defaultCfg(): NumberingCfg {
  return { prefix: '', digits: 2, start: 1, overflowPolicy: 'continue' }
}

export function validateCfg(cfg: NumberingCfg): string[] {
  const errs: string[] = []
  if (typeof cfg.prefix !== 'string') errs.push('前缀必须是文本')
  if (!Number.isInteger(cfg.digits) || cfg.digits < 1 || cfg.digits > 8)
    errs.push('号段位数必须是 1~8 之间的整数')
  if (!Number.isInteger(cfg.start) || cfg.start < 1) errs.push('起始号必须是 ≥1 的整数')
  if (cfg.start > 10 ** 8) errs.push('起始号过大')
  if (cfg.overflowPolicy !== 'continue' && cfg.overflowPolicy !== 'widen')
    errs.push('溢出策略只能是 continue 或 widen')
  return errs
}

/** 号段文本：正常件零填充到指定位数；continue 策略下的溢出件不截断、不补零，原样写出。 */
export function formatSerial(serial: number, digits: number, overflow: boolean): string {
  const s = String(serial)
  return overflow || s.length >= digits ? s : s.padStart(digits, '0')
}

export function makeLabel(cfg: NumberingCfg, serial: number, overflow: boolean): string {
  return `${cfg.prefix}${formatSerial(serial, cfg.digits, overflow)}`
}

interface InstKey {
  partId: string
  k: number
}
export function parseInstance(instanceId: string): InstKey {
  const m = instanceId.match(/^(.*)#(\d+)$/)
  return m ? { partId: m[1], k: Number(m[2]) } : { partId: instanceId, k: 0 }
}

/** 重排顺序：柜体 → 件名 → 件号编码 → partId → 同件第几件（确定、稳定、可复算）。 */
export function orderedPlacements(sheets: SheetResult[]): Placement[] {
  return sheets
    .flatMap((s) => s.placements)
    .map((p) => ({ p, key: parseInstance(p.instanceId) }))
    .sort((a, b) => {
      const c = a.p.cabinet.localeCompare(b.p.cabinet, 'zh')
      if (c) return c
      const n = a.p.name.localeCompare(b.p.name, 'zh')
      if (n) return n
      const cd = a.p.code.localeCompare(b.p.code)
      if (cd) return cd
      const id = a.key.partId.localeCompare(b.key.partId)
      if (id) return id
      return a.key.k - b.key.k
    })
    .map((x) => x.p)
}

export interface NumberingPlan {
  tags: PartTag[]
  /** 按当前位数会溢出的件（widen 时仅用于提示，标签本身不溢出） */
  overflowUnderCfg: { instanceId: string; serial: number }[]
  /** 实际生效的位数（widen 后可能大于用户填写值） */
  effectiveDigits: number
  widened: boolean
  collisions: { label: string; instanceIds: string[] }[]
}

/** 纯计算：给定排样结果与方案，产出一套号；不写任何状态。 */
export function planNumbering(sheets: SheetResult[], cfg: NumberingCfg): NumberingPlan {
  const ordered = orderedPlacements(sheets)
  const maxValue = 10 ** cfg.digits
  let effectiveDigits = cfg.digits
  let widened = false
  if (cfg.overflowPolicy === 'widen' && ordered.length > 0) {
    const maxSerial = cfg.start + ordered.length - 1
    const need = String(maxSerial).length
    if (need > cfg.digits) {
      effectiveDigits = need
      widened = true
    }
  }
  const overflowUnderCfg: NumberingPlan['overflowUnderCfg'] = []
  const tags: PartTag[] = ordered.map((p, i) => {
    const serial = cfg.start + i
    const overflow = serial >= maxValue
    if (overflow) overflowUnderCfg.push({ instanceId: p.instanceId, serial })
    // continue：溢出件原样写出；widen：已加宽，无溢出件
    const tagOverflow = overflow && cfg.overflowPolicy === 'continue'
    return {
      instanceId: p.instanceId,
      serial,
      label: makeLabel({ ...cfg, digits: effectiveDigits }, serial, tagOverflow),
      overflow: tagOverflow
    }
  })
  return {
    tags,
    overflowUnderCfg,
    effectiveDigits,
    widened,
    collisions: findCollisions(tags)
  }
}

export function findCollisions(tags: PartTag[]): { label: string; instanceIds: string[] }[] {
  const byLabel = new Map<string, string[]>()
  for (const t of tags) {
    const arr = byLabel.get(t.label) ?? []
    arr.push(t.instanceId)
    byLabel.set(t.label, arr)
  }
  return [...byLabel.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([label, instanceIds]) => ({ label, instanceIds }))
}

export function tagMap(job: Job): Map<string, PartTag> {
  const m = new Map<string, PartTag>()
  for (const t of job.numbering?.tags ?? []) m.set(t.instanceId, t)
  return m
}

/** 各页面统一取号口：拿不到新号时返回 null（由审计指出哪一处挂着老号），不许回退成老号。 */
export function tagOf(job: Job, instanceId: string): PartTag | null {
  return job.numbering?.tags.find((t) => t.instanceId === instanceId) ?? null
}

export function labelOf(job: Job, instanceId: string): string | null {
  return tagOf(job, instanceId)?.label ?? null
}

// ---------------------------------------------------------------------------
// 刀路逐刀核对：每一刀切出哪几件、这些件的号对不对得上
// ---------------------------------------------------------------------------

/**
 * 几何归属：这一刀贴着哪些零件的边下锯（供兼容老档/缺出处的刀路兜底使用）。
 */
export function geometricCutParts(sheet: SheetResult, kerf: number, order: number): string[] {
  const st = sheet.steps[order]
  if (!st || st.kind === 'trim') return []
  return geomPartsAt(sheet.placements, st.axis, st.at, st.span, kerf)
}

export interface CutAttribution {
  order: number
  axis: 'v' | 'h'
  kind: 'trim' | 'cut'
  provenance: string[] // 排样内核记录的「这一刀切谁」
  geometric: string[] // 由刀线几何反推的「这一刀切谁」
  resolved: string[] // 最终认定被这刀切出的件
  mismatch: { onlyProvenance: string[]; onlyGeometric: string[] }
}

/**
 * 逐刀归属：优先用排样内核带出的出处（partInstanceIds），
 * 老档/兼容路径缺出处时用几何归属兜底；两者都在时必须一致，不一致即拦住。
 */
export function attributeCuts(
  sheet: SheetResult,
  kerf: number
): { rows: CutAttribution[]; problems: NumberingIssue[] } {
  const rows: CutAttribution[] = []
  const problems: NumberingIssue[] = []
  for (const st of sheet.steps) {
    const prov = st.kind === 'cut' ? [...new Set(st.partInstanceIds ?? [])] : []
    // 几何归属：用真实 kerf 做容差
    const geom =
      st.kind === 'cut'
        ? geomPartsAt(sheet.placements, st.axis, st.at, st.span, kerf)
        : []
    let resolved: string[]
    // 一条贯通刀常被两侧多个件共用（父件先切、后摆子件共享同一条边），
    // 所以「几何贴上刀线的件」天然是「内核记录出处」的超集；
    // 真正要拦的是：内核声称贴着某件、几何上却根本不贴（出处被污染）。
    let mismatch: CutAttribution['mismatch'] = { onlyProvenance: [], onlyGeometric: [] }
    if (prov.length > 0) {
      const gs = new Set(geom)
      const badProv = prov.filter((id) => !gs.has(id))
      mismatch = { onlyProvenance: badProv, onlyGeometric: [] }
      resolved = [...new Set([...prov, ...geom])]
      if (badProv.length > 0) {
        problems.push({
          kind: 'cut',
          surface: '裁切步骤表',
          message:
            `第 ${sheet.index + 1} 张板第 ${st.order + 1} 刀（${st.label}）的刀路出处对不上：` +
            `记录称贴着 ${badProv.join('、')}，但该件几何上并不在这条刀线上`
        })
      }
    } else {
      resolved = geom
    }
    rows.push({
      order: st.order,
      axis: st.axis,
      kind: st.kind,
      provenance: prov,
      geometric: geom,
      resolved,
      mismatch
    })
  }
  return { rows, problems }
}

function geomPartsAt(
  placements: Placement[],
  axis: 'v' | 'h',
  at: number,
  span: [number, number],
  kerf: number
): string[] {
  const ids = new Set<string>()
  const tol = kerf + 0.6
  for (const p of placements) {
    if (axis === 'v') {
      const overlap = Math.min(p.y + p.widMm, span[1]) - Math.max(p.y, span[0])
      if (overlap <= EPS) continue
      if (Math.abs(at - (p.x + p.lenMm + kerf / 2)) <= tol) ids.add(p.instanceId)
      else if (Math.abs(at - (p.x - kerf / 2)) <= tol) ids.add(p.instanceId)
    } else {
      const overlap = Math.min(p.x + p.lenMm, span[1]) - Math.max(p.x, span[0])
      if (overlap <= EPS) continue
      if (Math.abs(at - (p.y + p.widMm + kerf / 2)) <= tol) ids.add(p.instanceId)
      else if (Math.abs(at - (p.y - kerf / 2)) <= tol) ids.add(p.instanceId)
    }
  }
  return [...ids]
}

// ---------------------------------------------------------------------------
// 全机一致性审计：六处取号口、逐刀核对、存储往返
// ---------------------------------------------------------------------------

export interface SurfaceStatus {
  key: SurfaceKey
  name: string
  ok: boolean
  stale: { instanceId: string; label: string }[] // 该位置还挂老号/拿不到新号的件
}

export interface NumberingAudit {
  ok: boolean
  hasNumbering: boolean
  issues: NumberingIssue[]
  surfaces: SurfaceStatus[]
  overflowTags: PartTag[]
  collisions: { label: string; instanceIds: string[] }[]
  cutRows: { sheetIndex: number; rows: CutAttribution[] }[]
}

function placementName(p: Placement): string {
  return `${p.code}（${p.name}，${p.cabinet}）`
}

export function numberingAudit(job: Job): NumberingAudit {
  const issues: NumberingIssue[] = []
  const sheets = job.result?.sheets ?? []
  const all = sheets.flatMap((s) => s.placements)
  const tags = job.numbering?.tags ?? []
  const byInstance = tagMap(job)

  // 1) 覆盖：每件都必须有号
  const missing = all.filter((p) => !byInstance.has(p.instanceId))
  // 2) 重号
  const collisions = findCollisions(tags)
  // 3) 溢出件（continue 策略下连号断开的位置）
  const overflowTags = tags.filter((t) => t.overflow)

  for (const m of missing) {
    issues.push({
      kind: 'missing',
      message: `件 ${placementName(m)}（实例 ${m.instanceId}）没有重排号，各处无法显示新号`
    })
  }
  for (const c of collisions) {
    issues.push({
      kind: 'collision',
      message: `件号 ${c.label} 在 ${c.instanceIds.length} 处撞号：${c.instanceIds.join('、')}（冲突必须先解决）`
    })
  }

  // 4) 逐刀核对：模拟切割 + 刀路出处/几何归属 + 每件都能被刀路成型
  const cutRows: NumberingAudit['cutRows'] = []
  const cutMissingTags = new Set<string>()
  const everCut = new Set<string>()
  for (const sheet of sheets) {
    const sim = simulate(sheet.wMm, sheet.hMm, job.kerfMm, sheet.steps, sheet.placements)
    if (!sim.ok) {
      issues.push({
        kind: 'cut',
        surface: '裁切步骤表',
        message: `第 ${sheet.index + 1} 张板逐刀模拟不过：${sim.errors.join('；')}（已拦住，不允许在这种刀路上贴号）`
      })
    }
    const { rows, problems } = attributeCuts(sheet, job.kerfMm)
    for (const p of problems) issues.push(p)
    for (const r of rows) {
      for (const id of r.resolved) {
        everCut.add(id)
        if (!byInstance.has(id)) cutMissingTags.add(id)
      }
    }
    cutRows.push({ sheetIndex: sheet.index, rows })
  }
  // 不挨着任何内部刀的件，只有一种合法情形：它占满修边后的整块可用区（靠修边刀成型）
  const trim = job.trimMm
  for (const p of all) {
    if (everCut.has(p.instanceId)) continue
    const sheet = sheets.find((s) => s.index === p.boardIndex)
    const fillsUsable =
      !!sheet &&
      Math.abs(p.x - trim) <= EPS &&
      Math.abs(p.y - trim) <= EPS &&
      Math.abs(p.x + p.lenMm - (sheet.wMm - trim)) <= 0.6 &&
      Math.abs(p.y + p.widMm - (sheet.hMm - trim)) <= 0.6
    if (!fillsUsable) {
      issues.push({
        kind: 'cut',
        surface: '裁切步骤表',
        message: `件 ${placementName(p)} 不被任何一刀切出（刀路与摆法对不上），已拦住`
      })
    }
  }
  for (const id of cutMissingTags) {
    const p = all.find((x) => x.instanceId === id)
    issues.push({
      kind: 'cut',
      surface: '裁切步骤表',
      message: `第 … 刀切出的件 ${p ? placementName(p) : id} 在重排号表里找不到号，裁切步骤表只能挂老号`
    })
  }

  // 5) 六处取号口一致性（同源：都从 numbering.tags 取；覆盖不到/重号的件逐处点名）
  const commonStale = missing.map((p) => ({ instanceId: p.instanceId, label: placementName(p) }))
  const cutStale = [
    ...commonStale,
    ...[...cutMissingTags].map((id) => ({
      instanceId: id,
      label: all.find((x) => x.instanceId === id)
        ? placementName(all.find((x) => x.instanceId === id)!)
        : id
    }))
  ]
  const surfaces: SurfaceStatus[] = NUMBERING_SURFACES.map(({ key, name }) => {
    if (key === 'storage') {
      let ok = true
      try {
        const rt = JSON.parse(JSON.stringify(job.numbering ?? null)) as Numbering | null
        ok = JSON.stringify(rt) === JSON.stringify(job.numbering ?? null)
      } catch {
        ok = false
      }
      return { key, name, ok, stale: [] }
    }
    if (key === 'cut') return { key, name, ok: cutStale.length === 0, stale: cutStale }
    if (key === 'stats') {
      // 统计页按柜体列件数：只依赖柜名与覆盖，与重号无直接关系
      return { key, name, ok: commonStale.length === 0, stale: commonStale }
    }
    return {
      key,
      name,
      ok: commonStale.length === 0 && collisions.length === 0,
      stale: commonStale
    }
  })
  for (const s of surfaces) {
    if (!s.ok && s.key !== 'storage') {
      issues.push({
        kind: 'stale',
        surface: s.name,
        message:
          s.stale.length > 0
            ? `${s.name} 还有 ${s.stale.length} 件挂着老号：${s.stale
                .slice(0, 6)
                .map((x) => x.label)
                .join('、')}${s.stale.length > 6 ? ' 等' : ''}`
            : `${s.name} 的号与统一号表不一致`
      })
    }
    if (!s.ok && s.key === 'storage') {
      issues.push({
        kind: 'stale',
        surface: s.name,
        message: `${s.name} 中的重排号无法完整往返保存，存盘的号会与各处不一致`
      })
    }
  }

  return {
    ok: issues.length === 0,
    hasNumbering: !!job.numbering,
    issues,
    surfaces,
    overflowTags,
    collisions,
    cutRows
  }
}

/** 排样内核指纹：重排前后摆法与刀路一个字节都不许变。 */
export function kernelFingerprint(job: Job): string {
  const sheets = job.result?.sheets ?? []
  return JSON.stringify(
    sheets.map((s) => ({
      index: s.index,
      placements: s.placements.map((p) => [
        p.instanceId,
        Math.round(p.x * 100),
        Math.round(p.y * 100),
        Math.round(p.lenMm * 100),
        Math.round(p.widMm * 100),
        p.rotated,
        p.seq
      ]),
      steps: s.steps.map((st) => [st.order, st.kind, st.axis, st.at, st.span])
    }))
  )
}

/** 重排预检：返回应用后是否会有拦截性问题（不写状态）。 */
export function previewRenumber(
  job: Job,
  cfg: NumberingCfg
): { plan: NumberingPlan | null; errors: string[]; audit: NumberingAudit | null } {
  const errors = validateCfg(cfg)
  if (!job.result) return { plan: null, errors: [...errors, '该项目还没有排样结果，无法编号'], audit: null }
  if (errors.length) return { plan: null, errors, audit: null }
  const plan = planNumbering(job.result.sheets, cfg)
  // 用「将要写入」的号跑一遍完整审计（含逐刀核对）
  const probe: Job = { ...job, numbering: { cfg, tags: plan.tags, source: 'user', appliedAt: 0 } }
  const audit = numberingAudit(probe)
  return { plan, errors, audit }
}
