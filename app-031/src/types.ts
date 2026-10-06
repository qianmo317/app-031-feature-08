// 数据模型（对应规格书 §7，进阶功能所需字段为可选扩展）

export type GrainDemand = 'length' | 'width' | 'none' // 竖纹 / 横纹 / 无要求
export type EdgeSide = 'top' | 'bottom' | 'left' | 'right'

export interface Board {
  id: string
  name: string
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  priceCents: number
  quantity: number // 库存张数，0 = 不限
  kind?: 'stock' | 'offcut' // stock 常规板材 / offcut 登记余料转来的小板
  offcutId?: string
}

export interface Part {
  id: string
  code: string
  name: string
  lenMm: number
  widMm: number
  qty: number
  grain: GrainDemand
  edgeBands: EdgeSide[]
  cabinet: string // 所在柜体/房间，便于分拣
  exposed: boolean // 是否见光
  boardId?: string // 指定板材类型，空 = 自动
}

export interface Placement {
  partId: string
  instanceId: string
  boardIndex: number
  x: number
  y: number
  lenMm: number // 实际占 x 方向的尺寸（纹理=横纹时为零件 wid，rotated 仍为 false）
  widMm: number // 实际占 y 方向的尺寸
  origLen: number // 清单录入尺寸（标签用）
  origWid: number
  rotated: boolean
  seq: number
  // 冗余展示字段
  code: string
  name: string
  cabinet: string
  exposed: boolean
  grain: GrainDemand
  edgeBands: EdgeSide[]
  adjusted?: boolean // 手工微调产生
}

export interface CutStep {
  boardIndex: number
  axis: 'v' | 'h'
  at: number // 切割线坐标（mm，板左下角原点）
  span: [number, number] // 贯通区间起止
  order: number
  kind: 'trim' | 'cut'
  label: string
}

export interface OffcutInfo {
  x: number
  y: number
  wMm: number
  hMm: number
  areaMm2: number
  usable: boolean // 两边 ≥300mm 才登记为可用余料，其余仅作碎料留档
}

export interface SheetResult {
  index: number
  boardId: string
  boardName: string
  material: string
  thicknessMm: number
  wMm: number
  hMm: number
  priceCents: number
  placements: Placement[]
  steps: CutStep[]
  usedAreaMm2: number
  boardAreaMm2: number
  utilization: number
  offcuts: OffcutInfo[]
  adjusted?: boolean
}

export interface UnplacedInfo {
  partId: string
  code: string
  name: string
  qty: number
  reason: string
}

export interface NestResult {
  sheets: SheetResult[]
  boardsUsed: number
  boardsByType: Record<string, number>
  edgeBandM: { exposed: number; normal: number }
  unplaced: UnplacedInfo[]
  baselineBoards: number // 随手排（朴素顺板）需要的张数
  savedBoards: number
  savedCents: number
  totalCostCents: number
  stockShortage: { boardId: string; boardName: string; need: number; have: number }[]
  elapsedMs: number
  generatedAt: number
}

// ===== 零件重排号（标签/打印用，与排样内核完全解耦）=====

/**
 * 位数溢出时的两条路（二选一，后果必须认下）：
 * - continue：溢出的几件接着往后单独排（全号显示），别的件一个不动；
 *   代价：该柜柜内连号的整齐断在这一处。
 * - widen：整批位数加宽后全部重排，连号完整；
 *   代价：已贴标签、已发下料单与裁切步骤表全部对不上号，必须整批作废重打。
 */
export type OverflowPolicy = 'continue' | 'widen'

export interface NumberingSpec {
  prefix: string // 号前缀（用户自填，可空）
  digits: number // 序号位数（不足补 0；超出位数时不截断）
  startAt: number // 每个柜的起号（≥1）
  overflow: OverflowPolicy
}

export interface NumberingTag {
  full: string // 打印/显示用完整号（如 A-001）
  cabinet: string
  indexInCabinet: number // 该柜内第几件（1 起）
  serial: number // 数字序号（= startAt + indexInCabinet - 1）
  overflow: boolean // 是否超出指定位数
}

export interface NumberingGroup {
  cabinet: string
  count: number
  firstSerial: number
  lastSerial: number
  overflowCount: number
}

export interface NumberingPlan {
  spec: NumberingSpec
  tags: Record<string, NumberingTag> // instanceId -> 号
  groups: NumberingGroup[]
  totalOverflow: number
  appliedAt: number
  /** manual=用户显式重排；default=旧项目读取时按默认规则补排，不能把老号当新号 */
  source: 'manual' | 'default'
}

export interface Job {
  id: string
  name: string
  createdAt: number
  boards: Board[]
  parts: Part[]
  kerfMm: number
  trimMm: number
  useOffcutIds: string[] // 参与本单排样的登记余料
  batchByCabinet: boolean // 按柜体批次分组开料
  result?: NestResult
  numbering?: NumberingPlan // 显示/打印号（可空；旧项目读取时按默认规则补排）
}

export interface RegisteredOffcut {
  id: string
  jobId: string
  jobName: string
  sheetIndex: number
  wMm: number
  hMm: number
  thicknessMm: number
  material: string
  createdAt: number
  available: boolean
  usedByJobId?: string
}
