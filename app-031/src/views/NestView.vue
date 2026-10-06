<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { getJob, runNest, applyAdjustment, registerOffcuts, useStore, applyNumbering } from '../lib/store'
import { toast } from '../lib/ui'
import { printJob } from '../lib/print'
import { pct, money } from '../lib/format'
import SheetDiagram from '../components/SheetDiagram.vue'
import { cabinetFill, cabinetStroke } from '../lib/colors'
import {
  auditNumbering,
  buildNumbering,
  groupRange,
  orderedInstances,
  tagText,
  DEFAULT_SPEC,
  type NumberingAudit
} from '../lib/numbering'
import type { NumberingSpec, OverflowPolicy } from '../types'

const route = useRoute()
const job = computed(() => getJob(route.params.id as string))
const result = computed(() => job.value?.result)

const activeSheet = ref(0)
const sheet = computed(() => result.value?.sheets[activeSheet.value])
const adjustMode = ref(false)
const selectedId = ref<string | null>(null)

const overallUtil = computed(() => {
  if (!result.value || result.value.sheets.length === 0) return 0
  const used = result.value.sheets.reduce((a, s) => a + s.usedAreaMm2, 0)
  const total = result.value.sheets.reduce((a, s) => a + s.boardAreaMm2, 0)
  return total > 0 ? used / total : 0
})
const cabinets = computed(() => {
  const set = new Set<string>()
  result.value?.sheets.forEach((s) => s.placements.forEach((p) => set.add(p.cabinet)))
  return [...set].sort()
})

// ===== 按柜体重排号 =====
const numberingPanelOpen = ref(true)
function specForm(): NumberingSpec {
  const cur = job.value?.numbering?.spec ?? DEFAULT_SPEC
  return { prefix: cur.prefix, digits: cur.digits, startAt: cur.startAt, overflow: cur.overflow }
}
const form = reactive<NumberingSpec>(specForm())
const audit = computed<NumberingAudit | null>(() => (job.value ? auditNumbering(job.value) : null))
/** 当前表单规则下的预排（不落库），用于在按钮旁看溢出与号段 */
const preview = computed(() => {
  if (!job.value?.result) return { plan: null, errors: [] as string[] }
  try {
    return {
      plan: buildNumbering(
        { ...form },
        job.value.result,
        job.value.numbering?.source ?? 'default'
      ),
      errors: [] as string[]
    }
  } catch (e) {
    return { plan: null, errors: [e instanceof Error ? e.message : '规则不合法'] }
  }
})

const overflowItems = computed(() => {
  if (!preview.value.plan || preview.value.plan.totalOverflow === 0) return []
  return orderedInstances(result.value!)
    .map((p) => ({ p, t: preview.value.plan!.tags[p.instanceId] }))
    .filter((x) => x.t.overflow)
})

const policyDefs: { key: OverflowPolicy; title: string; cost: string }[] = [
  {
    key: 'continue',
    title: '溢出件接着往后单独排',
    cost: '别的件一个不动；代价：该柜柜内连号的整齐断在这一处，断口之后的号比指定位数长。'
  },
  {
    key: 'widen',
    title: '整批位数加宽重排',
    cost: '连号完整；代价：已贴在件上的标签、已发出去的下料单与裁切步骤表全部对不上号，必须整批作废重打。'
  }
]

function doRenumber(): void {
  if (!job.value) return
  if (form.overflow === 'widen' && overflowItems.value.length > 0) {
    const ok = window.confirm(
      `加宽到能容纳最大序号后整批重排，连号完整；但已贴标签、已发下料单与裁切步骤表将全部对不上号，需要整批作废重打。\n\n仍要整批加宽重排吗？`
    )
    if (!ok) return
  }
  const res = applyNumbering(job.value, { ...form })
  if (!res.ok) {
    // 闸门拦住：逐刀回看出对不上的件
    toast(`重排已拦住并回退：${res.error}`, 'bad', 6000)
    return
  }
  const overflow = res.plan?.totalOverflow ?? 0
  toast(
    overflow > 0 && form.overflow === 'continue'
      ? `已重排，${overflow} 件位数不够，按规则接着往后单独排（柜内连号在此断口）`
      : '整批号已一次写成，图/标签/下料单/步骤表/统计/存储已统一',
    'good',
    4200
  )
}

// 已登记余料：以 (项目, 板, 尺寸) 判重
const { state } = useStore()
function registered(si: number, o: { x: number; y: number; wMm: number; hMm: number }): boolean {
  const j = job.value
  if (!j) return false
  return state.offcuts.some(
    (x) => x.jobId === j.id && x.sheetIndex === si && x.wMm === o.wMm && x.hMm === o.hMm
  )
}

function registerSheet(si: number): void {
  if (!job.value?.result) return
  const s = job.value.result.sheets[si]
  const picks = s.offcuts
    .filter((o) => o.usable && !registered(si, o))
    .map((o) => ({ sheetIndex: si, x: o.x, y: o.y, wMm: o.wMm, hMm: o.hMm }))
  if (picks.length === 0) {
    toast('该板没有新的可用余料（≥300×300mm）可登记')
    return
  }
  const n = registerOffcuts(job.value, picks)
  toast(`已登记 ${n} 块余料，可在下次开料优先使用`, 'good')
}
function registerAll(): void {
  if (!job.value?.result) return
  let n = 0
  job.value.result.sheets.forEach((s, si) => {
    const picks = s.offcuts
      .filter((o) => o.usable && !registered(si, o))
      .map((o) => ({ sheetIndex: si, x: o.x, y: o.y, wMm: o.wMm, hMm: o.hMm }))
    n += registerOffcuts(job.value!, picks)
  })
  toast(n > 0 ? `已登记全部 ${n} 块余料` : '所有余料均已登记', n > 0 ? 'good' : 'info')
}

function rerun(): void {
  if (!job.value) return
  runNest(job.value)
  Object.assign(form, specForm())
  activeSheet.value = 0
  toast('已重新排样（摆法与刀路已更新；显示号按原规则自动重排）', 'good')
}

function lookupTag(instanceId: string): string {
  return tagText(job.value, instanceId)
}

function onDrop(payload: { instanceId: string; xMm: number; yMm: number }): void {
  if (!job.value?.result || !sheet.value) return
  const si = sheet.value.index
  const placements = sheet.value.placements.map((p) => ({ ...p }))
  const moved = placements.find((p) => p.instanceId === payload.instanceId)
  if (!moved) return
  const EPS = 0.1
  const TOL = 0.5
  const target = sheet.value.placements.find(
    (p) =>
      p.instanceId !== payload.instanceId &&
      payload.xMm >= p.x - TOL &&
      payload.yMm >= p.y - TOL &&
      payload.xMm <= p.x + p.lenMm + TOL &&
      payload.yMm <= p.y + p.widMm + TOL
  )
  if (target) {
    const other = placements.find((p) => p.instanceId === target.instanceId)!
    const fitAB = moved.lenMm <= target.lenMm + EPS && moved.widMm <= target.widMm + EPS
    const fitBA = other.lenMm <= moved.lenMm + EPS && other.widMm <= moved.widMm + EPS
    if (!fitAB || !fitBA) {
      adjustFail('两件槽位尺寸不兼容，交换后非贯通')
      return
    }
    const ax = moved.x
    const ay = moved.y
    moved.x = other.x
    moved.y = other.y
    other.x = ax
    other.y = ay
  } else {
    const oc = sheet.value.offcuts.find(
      (o) =>
        payload.xMm >= o.x - TOL &&
        payload.yMm >= o.y - TOL &&
        payload.xMm <= o.x + o.wMm + TOL &&
        payload.yMm <= o.y + o.hMm + TOL &&
        o.wMm + EPS >= moved.lenMm &&
        o.hMm + EPS >= moved.widMm
    )
    if (!oc) {
      adjustFail('落点必须在虚线余料矩形内，或拖到另一零件上交换')
      return
    }
    moved.x = oc.x
    moved.y = oc.y
  }
  const t0 = performance.now()
  const err = applyAdjustment(job.value, si, placements)
  const ms = performance.now() - t0
  if (err) adjustFail(`${err}（校验耗时 ${ms.toFixed(1)}ms，已撤销）`)
  else {
    toast(`微调生效，已重算刀路（增量校验 ${ms.toFixed(1)}ms）`, 'good')
    selectedId.value = moved.instanceId
  }
}
function adjustFail(msg: string): void {
  toast(msg, 'bad', 3800)
}

const selected = computed(() =>
  sheet.value?.placements.find((p) => p.instanceId === selectedId.value) ?? null
)

function printNest(): void {
  if (job.value) printJob(job.value.id, ['nest'])
}
</script>

<template>
  <div v-if="job && result">
    <!-- 总览条 -->
    <section class="panel kpi-bar">
      <div><b>{{ result.boardsUsed }}</b><span>板材（张）</span></div>
      <div><b>{{ pct(overallUtil) }}</b><span>综合利用率</span></div>
      <div><b>{{ (result.edgeBandM.exposed + result.edgeBandM.normal).toFixed(1) }}m</b><span>封边总长</span></div>
      <div class="hl"><b>省 {{ result.savedBoards }} 张</b><span>约 {{ money(result.savedCents) }}</span></div>
      <div class="spacer" />
      <button class="sm" @click="rerun">重新排样</button>
      <button class="sm" @click="registerAll">登记全部余料</button>
      <button class="sm primary" @click="printNest">打印排样图</button>
      <router-link class="sm btn-like" :to="`/cut/${job.id}`">看裁切步骤 →</router-link>
    </section>

    <div v-if="result.unplaced.length > 0" class="alert bad">
      <b>{{ result.unplaced.reduce((a, u) => a + u.qty, 0) }} 件未排下：</b>
      <span v-for="u in result.unplaced" :key="u.partId" class="alert-item">
        {{ u.code }}（{{ u.name }}）×{{ u.qty }}：{{ u.reason }}
      </span>
    </div>
    <div v-for="sh in result.stockShortage" :key="sh.boardId" class="alert warn">
      库存不足：{{ sh.boardName }} 需要 {{ sh.need }} 张，库存仅 {{ sh.have }} 张，请补采 {{ sh.need - sh.have }} 张。
    </div>

    <!-- 按柜体/件名重排号 -->
    <section class="panel renumber no-print">
      <div class="row" style="cursor: pointer" @click="numberingPanelOpen = !numberingPanelOpen">
        <h3 style="font-size: 14px; margin: 0">按柜体 / 件名重排号（只改显示与打印，摆法与刀路不动）</h3>
        <div class="spacer" />
        <span class="small muted">{{ numberingPanelOpen ? '收起 ▲' : '展开 ▼' }}</span>
      </div>
      <div v-if="numberingPanelOpen" class="rn-body">
        <div v-if="audit && audit.source === 'default'" class="alert info" style="margin: 8px 0">
          ⚠️ 这是早先存下的项目，原先没有柜体/前缀这一套号：当前号是<b>按默认规则重排出来的</b>
          （前缀为空、{{ DEFAULT_SPEC.digits }} 位、每柜从 {{ DEFAULT_SPEC.startAt }} 号起），不是原始老号；如需正式号请在下面改规则后重排。
        </div>
        <div v-if="audit && !audit.ok && audit.source !== 'default'" class="alert bad" style="margin: 8px 0">
          <b>几处号不一致，已拦住打印判断：</b>
          <span v-for="(p2, i) in audit.problems" :key="i" class="alert-item">· {{ p2.problem }}（{{ [...new Set(p2.surfaces)].join('、') }}）</span>
        </div>

        <div class="rn-form">
          <label class="rn-field">
            <span>前缀</span>
            <input v-model="form.prefix" maxlength="12" placeholder="如 A-（可空）" />
          </label>
          <label class="rn-field small-field">
            <span>序号位数</span>
            <input v-model.number="form.digits" type="number" min="1" max="6" />
          </label>
          <label class="rn-field small-field">
            <span>每柜起号</span>
            <input v-model.number="form.startAt" type="number" min="1" max="999999" />
          </label>
        </div>
        <div v-for="d in policyDefs" :key="d.key" class="rn-policy" :class="{ on: form.overflow === d.key }">
          <label class="row" style="gap: 8px; align-items: flex-start">
            <input type="radio" :value="d.key" v-model="form.overflow" style="margin-top: 3px" />
            <span>
              <b>{{ d.title }}</b><br />
              <span class="small muted">{{ d.cost }}</span>
            </span>
          </label>
        </div>

        <div v-if="preview.errors.length" class="alert bad" style="margin: 8px 0">
          {{ preview.errors.join('；') }}
        </div>

        <div class="rn-preview">
          <div class="small muted">预览号段（按柜体 → 件名 → 板上位置连号）：</div>
          <div class="rn-groups">
            <span v-for="g in preview.plan?.groups ?? []" :key="g.cabinet" class="rn-grp">
              <b>{{ g.cabinet }}</b>
              <span>{{ g.count }} 件 · {{ groupRange(preview.plan!, g) }}</span>
              <span v-if="g.overflowCount" class="tag bad">溢出 {{ g.overflowCount }} 件</span>
            </span>
          </div>
          <div v-if="overflowItems.length > 0" class="rn-overflow">
            <b :class="form.overflow === 'widen' ? 'warn-text' : 'bad-text'">
              {{ overflowItems.length }} 件位数不够（超出 {{ form.digits }} 位）：
            </b>
            <span v-for="x in overflowItems" :key="x.p.instanceId" class="alert-item">
              {{ x.p.cabinet }} / {{ x.p.code }}（{{ x.p.name }}）→ 实际号 {{ x.t.serial }}
            </span>
            <p class="small muted" style="margin: 4px 0 0">
              号不会被截断；按上面选的路处理：继续排则这几件单独用全号、别的件不动；加宽则整批改写、旧标签与单据作废重打。
            </p>
          </div>
        </div>

        <div class="row" style="margin-top: 10px">
          <button class="primary" @click="doRenumber">整批重排（一次写成，重复点击不会重复加前缀）</button>
          <span v-if="job.numbering" class="small muted">
            当前这套号：{{ job.numbering.source === 'manual' ? '用户重排' : '默认补排' }} ·
            前缀「{{ job.numbering.spec.prefix }}」· {{ job.numbering.spec.digits }} 位 ·
            每柜 {{ job.numbering.spec.startAt }} 起 ·
            溢出{{ job.numbering.spec.overflow === 'widen' ? '整批加宽' : '续号' }}
          </span>
        </div>
        <p class="small muted" style="margin: 6px 0 0">
          落库前会按贯通切割顺序逐刀回看：每刀切出哪一件、这件的号对不对得上；对不上的件会被拦住并点名，整批回退。
        </p>
      </div>
    </section>

    <div class="layout">
      <!-- 左：板标签 -->
      <aside class="sheet-tabs no-print">
        <button
          v-for="s in result.sheets"
          :key="s.index"
          class="sheet-tab"
          :class="{ active: s.index === activeSheet }"
          @click="activeSheet = s.index"
        >
          <b>第 {{ s.index + 1 }} 张</b>
          <span>{{ s.boardName.length > 14 ? s.material + ' ' + s.thicknessMm + 'mm' : s.boardName }}</span>
          <span class="ut">{{ pct(s.utilization) }}</span>
        </button>
      </aside>

      <!-- 中：图 -->
      <section class="panel canvas-panel">
        <div class="row" style="margin-bottom: 8px">
          <b>第 {{ activeSheet + 1 }} 张 / 共 {{ result.sheets.length }} 张</b>
          <span class="tag">{{ sheet?.boardName }}</span>
          <span class="tag good">利用率 {{ pct(sheet?.utilization ?? 0) }}</span>
          <span v-if="sheet?.adjusted" class="tag warn">已手工微调</span>
          <div class="spacer" />
          <label class="row small" style="gap:4px">
            <input type="checkbox" v-model="adjustMode" />
            手工微调（拖动/交换）
          </label>
        </div>

        <div class="svg-wrap" :class="{ adjusting: adjustMode }">
          <SheetDiagram
            v-if="sheet"
            :sheet="sheet"
            :draggable="adjustMode"
            :selected-id="selectedId"
            :tag-lookup="lookupTag"
            @drop="onDrop"
            @select="(id) => (selectedId = id)"
          />
        </div>
        <p v-if="adjustMode" class="small muted">
          拖动零件到虚线余料矩形内可移位；拖到另一零件上可交换（要求互相放得下）。
          每次松手都会重新做 guillotine 合法性校验，非贯通排法会被拒绝并撤销。
        </p>

        <div class="row wrap" style="margin-top: 10px">
          <span class="small muted">同色 = 同柜体：</span>
          <span v-for="c in cabinets" :key="c" class="legend">
            <i :style="{ background: cabinetFill(c), borderColor: cabinetStroke(c) }"></i>{{ c }}
          </span>
        </div>
      </section>

      <!-- 右：零件/余料明细 -->
      <aside class="side panel no-print">
        <h4>本板零件（{{ sheet?.placements.length }}）</h4>
        <div class="mini-list">
          <div
            v-for="p in sheet?.placements ?? []"
            :key="p.instanceId"
            class="mini-row"
            :class="{ sel: selectedId === p.instanceId }"
            @click="selectedId = p.instanceId"
          >
            <b>{{ lookupTag(p.instanceId) }} <span class="muted small">{{ p.code }}</span></b>
            <span>{{ p.origLen }}×{{ p.origWid }} · {{ p.cabinet }}</span>
          </div>
        </div>
        <h4 style="margin-top: 12px">可用余料</h4>
        <p v-if="(sheet?.offcuts.filter((o) => o.usable).length ?? 0) === 0" class="small muted">
          本板没有 ≥300×300mm 的余料
        </p>
        <div
          v-for="(o, i) in sheet?.offcuts.filter((x) => x.usable) ?? []"
          :key="i"
          class="oc-row"
        >
          <span>{{ o.wMm }}×{{ o.hMm }}mm · {{ (o.areaMm2 / 1e6).toFixed(2) }}m²</span>
          <span v-if="registered(sheet!.index, o)" class="tag good">已登记</span>
        </div>
        <button class="sm" style="margin-top: 8px" @click="registerSheet(sheet!.index)">
          登记本板余料
        </button>

        <div v-if="selected" class="sel-detail">
          <h4>选中：{{ lookupTag(selected.instanceId) }} <span class="muted small">{{ selected.code }}</span></h4>
          <p class="small">
            {{ selected.name }}<br />
            尺寸 {{ selected.origLen }}×{{ selected.origWid }}mm
            （就位 {{ Math.round(selected.lenMm) }}×{{ Math.round(selected.widMm) }}）<br />
            位置 ({{ Math.round(selected.x) }}, {{ Math.round(selected.y) }})<br />
            {{ selected.cabinet }} · {{ selected.grain === 'length' ? '竖纹' : selected.grain === 'width' ? '横纹' : '纹理无要求' }}
            · 封边 {{ selected.edgeBands.length }} 边{{ selected.exposed ? ' · 见光' : '' }}
          </p>
        </div>
      </aside>
    </div>
  </div>
  <div v-else class="panel empty">
    <p>该项目还没有排样结果。</p>
    <router-link :to="`/parts/${route.params.id}`"><button class="primary">去录入零件并排样</button></router-link>
  </div>
</template>

<style scoped>
.kpi-bar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.kpi-bar > div {
  display: flex;
  flex-direction: column;
}
.kpi-bar b {
  font-size: 20px;
  font-variant-numeric: tabular-nums;
}
.kpi-bar span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.kpi-bar .hl b {
  color: var(--c-primary);
}
.btn-like {
  border: 1px solid var(--c-line);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  text-decoration: none;
}
.alert {
  border-radius: 8px;
  padding: 9px 14px;
  margin-bottom: 10px;
  font-size: 13px;
}
.alert.bad {
  background: var(--c-bad-bg);
  border: 1px solid #eecfcf;
  color: var(--c-bad);
}
.alert.warn {
  background: #fffbeb;
  border: 1px solid #f0d9b5;
  color: #92600a;
}
.alert-item {
  margin-right: 14px;
  white-space: nowrap;
}
.layout {
  display: grid;
  grid-template-columns: 132px 1fr 282px;
  gap: 12px;
  align-items: start;
}
.sheet-tabs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: sticky;
  top: 70px;
}
.sheet-tab {
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px;
}
.sheet-tab b {
  font-size: 13px;
}
.sheet-tab span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.sheet-tab .ut {
  font-weight: 700;
  color: var(--c-accent);
}
.sheet-tab.active {
  border-color: var(--c-primary);
  background: #fff7ed;
}
.canvas-panel {
  min-width: 0;
}
.svg-wrap {
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: #fff;
  padding: 8px;
}
.svg-wrap.adjusting {
  border-color: var(--c-primary);
  border-style: dashed;
}
.legend {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.legend i {
  display: inline-block;
  width: 13px;
  height: 13px;
  border: 1.5px solid;
  border-radius: 3px;
}
.side {
  max-height: calc(100vh - 90px);
  overflow: auto;
}
.side h4 {
  font-size: 13px;
}
.mini-list {
  max-height: 300px;
  overflow-y: auto;
  border: 1px solid var(--c-line-soft);
  border-radius: 6px;
}
.mini-row {
  padding: 4px 8px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--c-line-soft);
}
.mini-row:last-child {
  border-bottom: none;
}
.mini-row span {
  font-size: 11px;
  color: var(--c-ink-2);
}
.mini-row.sel {
  background: #fff7ed;
}
.oc-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  padding: 4px 0;
  border-bottom: 1px dashed var(--c-line-soft);
}
.sel-detail {
  margin-top: 14px;
  border-top: 1px solid var(--c-line);
  padding-top: 8px;
}
.empty {
  text-align: center;
  padding: 50px;
}
.renumber {
  margin-bottom: 12px;
  background: #fcfdfb;
}
.rn-body {
  margin-top: 10px;
}
.alert.info {
  background: #eff6ff;
  border: 1px solid #c6ddf8;
  color: #1e4d8c;
}
.rn-form {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.rn-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 12px;
  color: var(--c-ink-2);
}
.rn-field input {
  padding: 6px 8px;
  border: 1px solid var(--c-line);
  border-radius: 6px;
  font-size: 13px;
}
.small-field input {
  width: 92px;
}
.rn-policy {
  border: 1px solid var(--c-line-soft);
  border-radius: 8px;
  padding: 7px 10px;
  margin: 5px 0;
  cursor: pointer;
}
.rn-policy.on {
  border-color: var(--c-primary);
  background: #fff7ed;
}
.rn-preview {
  margin-top: 8px;
  border-top: 1px dashed var(--c-line-soft);
  padding-top: 8px;
}
.rn-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin: 5px 0;
}
.rn-grp {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}
.rn-overflow {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.7;
}
.bad-text {
  color: var(--c-bad);
}
.warn-text {
  color: #92600a;
}
@media (max-width: 1100px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .sheet-tabs {
    flex-direction: row;
    overflow-x: auto;
    position: static;
  }
}
</style>
