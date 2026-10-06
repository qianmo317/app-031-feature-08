<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { getJob, runNest, applyAdjustment, registerOffcuts, useStore, applyRenumber } from '../lib/store'
import { toast } from '../lib/ui'
import { printJob } from '../lib/print'
import { pct, money } from '../lib/format'
import SheetDiagram from '../components/SheetDiagram.vue'
import { cabinetFill, cabinetStroke } from '../lib/colors'
import {
  numberingAudit,
  previewRenumber,
  defaultCfg,
  type NumberingAudit
} from '../lib/numbering'
import type { NumberingCfg, OverflowPolicy } from '../types'

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
  activeSheet.value = 0
  toast('已重新排样', 'good')
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

// ---- 标签按柜体重排 -------------------------------------------------------
const renumberOpen = ref(false)
const renForm = ref<NumberingCfg>(defaultCfg())
const renPreview = ref<ReturnType<typeof previewRenumber> | null>(null)
const audit = computed<NumberingAudit | null>(() => (job.value ? numberingAudit(job.value) : null))

const isMigration = computed(() => job.value?.numbering?.source === 'migration')
const numbering = computed(() => job.value?.numbering)

const tagFor = (instanceId: string): string | null => {
  if (!job.value) return null
  return job.value.numbering?.tags.find((t) => t.instanceId === instanceId)?.label ?? null
}

function cabinetRanges(): { cabinet: string; count: number; from: string; to: string; broken: boolean }[] {
  const j = job.value
  if (!j?.numbering || !j.result) return []
  const byCab = new Map<string, { tags: { label: string; overflow: boolean; serial: number }[] }>()
  for (const s of j.result.sheets) {
    for (const p of s.placements) {
      const t = j.numbering.tags.find((x) => x.instanceId === p.instanceId)
      if (!t) continue
      const arr = byCab.get(p.cabinet) ?? { tags: [] }
      arr.tags.push(t)
      byCab.set(p.cabinet, arr)
    }
  }
  return [...byCab.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
    .map(([cabinet, v]) => {
      const ts = v.tags.sort((a, b) => a.serial - b.serial)
      const broken = ts.some((t, i) => i > 0 && t.serial !== ts[i - 1].serial + 1)
      return { cabinet, count: ts.length, from: ts[0]?.label ?? '-', to: ts[ts.length - 1]?.label ?? '-', broken }
    })
}
const cabinetRangeList = computed(() => cabinetRanges())

function openRenumber(): void {
  if (!job.value?.result) return
  const cur = job.value.numbering?.cfg ?? defaultCfg()
  // 从当前方案填入编辑框；前缀取自配置本身，重复点不会在旧前缀上再接一遍
  renForm.value = {
    prefix: cur.prefix,
    digits: cur.digits,
    start: cur.start,
    overflowPolicy: cur.overflowPolicy
  }
  renumberOpen.value = true
  updatePreview()
}
function updatePreview(): void {
  if (!job.value) return
  renPreview.value = previewRenumber(job.value, { ...renForm.value })
}
function setPolicy(p: OverflowPolicy): void {
  renForm.value.overflowPolicy = p
  updatePreview()
}

const blockingIssues = computed(() => renPreview.value?.audit?.issues ?? [])
const overflowPreview = computed(
  () =>
    renPreview.value?.plan?.overflowUnderCfg.map((o) => {
      const p = result.value?.sheets
        .flatMap((s) => s.placements)
        .find((x) => x.instanceId === o.instanceId)
      return {
        instanceId: o.instanceId,
        serial: o.serial,
        text: p ? `${p.code}（${p.name}·${p.cabinet}）` : o.instanceId
      }
    }) ?? []
)

function doRenumber(): void {
  if (!job.value) return
  const cfg = { ...renForm.value }
  const policyNote =
    cfg.overflowPolicy === 'widen'
      ? '加宽重排后，已经贴在件上的标签、已发出的下料单与裁切步骤表全部对不上号，必须整批作废重打（撕旧标、换新单，返工落在车间）。确认继续？'
      : 'continue 策略只动溢出件、其余件一个不动，柜内连号会在溢出位置断开，已发单据不用改。确认应用？'
  if (!window.confirm(policyNote)) return
  const r = applyRenumber(job.value, cfg)
  if (r.ok) {
    const plan = r.plan
    const widened = plan?.widened
      ? `（${renForm.value.digits} 位放不下，已自动加宽到 ${plan?.effectiveDigits} 位，全套重发）`
      : ''
    const overflow =
      cfg.overflowPolicy === 'continue' && (plan?.overflowUnderCfg.length ?? 0) > 0
        ? `，其中 ${plan?.overflowUnderCfg.length} 件溢出顺延、不补零（柜内连号在此断开）`
        : ''
    toast(`标签已按柜体+件名重排${widened}${overflow}。重排只改显示/打印号，摆法与刀路未动。`, 'good', 4200)
    renumberOpen.value = false
  } else {
    toast(r.errors.join('；') || '重排被拦截', 'bad', 5200)
    updatePreview()
  }
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

    <!-- 老项目兼容提示：这套号是按默认规则重排出来的，老号（摆放先后）已不作新号 -->
    <div v-if="isMigration" class="alert info">
      本项目是早先版本存下的，没有柜体前缀方案。已按默认规则（无前缀、2 位、从 1 起、溢出顺延）
      <b>重排了一套标签号</b>，并标明「兼容重排」；原来的摆放先后号已停用，不会被当成新号。
      可在下方「按柜体重排标签」里改成自己的前缀/位数/起点。
    </div>

    <!-- 六处取号口一致性 / 逐刀核对结果 -->
    <div v-if="audit && !audit.ok" class="alert bad">
      <b>标签号一致性核对未通过（已拦住）：</b>
      <div v-for="(iss, i) in audit.issues.slice(0, 8)" :key="i" class="alert-item">· {{ iss.message }}</div>
    </div>

    <!-- 按柜体重排标签 -->
    <section class="panel renumber-panel">
      <div class="row" style="align-items: center">
        <b>零件标签号（按柜体+件名连号）</b>
        <span v-if="numbering" class="tag" :class="numbering.source === 'user' ? 'good' : ''">
          {{ numbering.source === 'user' ? '用户重排' : numbering.source === 'migration' ? '兼容重排（默认规则）' : '默认编号' }}
          · 前缀「{{ numbering.cfg.prefix }}」· {{ numbering.cfg.digits }} 位 · 从 {{ numbering.cfg.start }} 起
          · {{ numbering.cfg.overflowPolicy === 'widen' ? '位数不够整批加宽' : '位数不够溢出顺延' }}
        </span>
        <div class="spacer" />
        <button class="sm primary" @click="openRenumber">按柜体重排标签…</button>
      </div>
      <div v-if="audit" class="surface-row">
        <span
          v-for="s in audit.surfaces"
          :key="s.key"
          class="tag"
          :class="s.ok ? 'good' : 'bad'"
          :title="s.stale.map((x) => x.label).join('、')"
        >{{ s.ok ? '✓' : '✗' }} {{ s.name }}</span>
      </div>
      <table v-if="cabinetRangeList.length" class="cab-grid">
        <thead>
          <tr><th>柜体/房间</th><th>件数</th><th>号段</th><th>连号</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in cabinetRangeList" :key="r.cabinet">
            <td>{{ r.cabinet }}</td>
            <td>{{ r.count }}</td>
            <td>{{ r.from }} ~ {{ r.to }}</td>
            <td>
              <span :class="r.broken ? 'tag bad' : 'tag good'">{{ r.broken ? '有断开（溢出顺延）' : '连号' }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 重排对话框（一次写成；不确认不写） -->
    <div v-if="renumberOpen" class="modal-mask no-print" @click.self="renumberOpen = false">
      <section class="panel modal">
        <h3 style="font-size: 15px">按柜体与件名重排标签号</h3>
        <p class="small muted">
          同一柜体的件按「件名→件号」连号；只改显示与打印用的号，排样摆法与贯通刀路一律不动。
          改完会按刀序逐刀回看每一刀切出哪件、号对不对得上。
        </p>
        <div class="form-grid">
          <label>前缀
            <input v-model="renForm.prefix" @input="updatePreview" placeholder="如 A-、衣柜 或留空" maxlength="12" />
          </label>
          <label>号段位数
            <input type="number" min="1" max="8" v-model.number="renForm.digits" @input="updatePreview" />
          </label>
          <label>起始号
            <input type="number" min="1" v-model.number="renForm.start" @input="updatePreview" />
          </label>
        </div>
        <div class="policy-box">
          <b>位数放不下时只有两条路（认下后果）：</b>
          <label class="policy" :class="{ on: renForm.overflowPolicy === 'continue' }">
            <input type="radio" :checked="renForm.overflowPolicy === 'continue'" @change="setPolicy('continue')" />
            <span>
              <b>① 溢出件接着往后单独排，别的件一个不动</b><br />
              让出的是「整齐」：该柜连号在溢出位置断开（出现不补零的长号）。
              <b>代价落在现场</b>：已贴标签、已发下料单/裁切步骤表都不用改；该柜分拣时号不连贯，靠件名补。
            </span>
          </label>
          <label class="policy" :class="{ on: renForm.overflowPolicy === 'widen' }">
            <input type="radio" :checked="renForm.overflowPolicy === 'widen'" @change="setPolicy('widen')" />
            <span>
              <b>② 整批加宽位数重排，连号完整</b><br />
              让出的是「已经发出的一切」：贴在件上的标签、发出去的下料单与裁切步骤表
              <b>全部对不上号，必须整批作废重打</b>。代价落在车间：撕旧标、换单、重新核对。
            </span>
          </label>
        </div>

        <div v-if="renPreview && renPreview.errors.length === 0" class="preview-box">
          <p class="small">
            预览：共 {{ renPreview.plan?.tags.length }} 件，柜内连号；
            <template v-if="renForm.overflowPolicy === 'continue'">
              <span :class="overflowPreview.length ? 'bad-text' : ''">
                {{ overflowPreview.length ? `${overflowPreview.length} 件超过 ${renForm.digits} 位，将不补零顺延（不截断）` : `${renForm.digits} 位放得下，无溢出` }}
              </span>
            </template>
            <template v-else>
              <span :class="renPreview.plan?.widened ? 'warn-text' : ''">
                {{ renPreview.plan?.widened
                  ? `${renForm.digits} 位放不下，整批将加宽到 ${renPreview.plan.effectiveDigits} 位重发（旧标签/旧单全部作废）`
                  : `${renForm.digits} 位放得下，无需加宽` }}
              </span>
            </template>
          </p>
          <div v-if="overflowPreview.length && renForm.overflowPolicy === 'continue'" class="ov-list">
            溢出的件：
            <span v-for="o in overflowPreview.slice(0, 12)" :key="o.instanceId" class="tag bad">
              {{ renForm.prefix }}{{ o.serial }} · {{ o.text }}
            </span>
            <span v-if="overflowPreview.length > 12" class="small muted">等 {{ overflowPreview.length }} 件</span>
          </div>
          <p class="small muted" style="margin-top:4px">
            号段示例：
            <b>{{ renPreview.plan?.tags[0]?.label }}</b>
            <template v-if="(renPreview.plan?.tags.length ?? 0) > 1">
              … <b>{{ renPreview.plan?.tags[renPreview.plan.tags.length - 1]?.label }}</b>
            </template>
          </p>
          <div v-if="blockingIssues.length" class="alert bad" style="margin-top:6px">
            按此方案写入会被拦住：
            <div v-for="(iss, i) in blockingIssues.slice(0, 6)" :key="i">· {{ iss.message }}</div>
          </div>
        </div>
        <div v-else-if="renPreview" class="alert bad">
          <div v-for="(e, i) in renPreview.errors" :key="i">· {{ e }}</div>
        </div>

        <div class="row" style="margin-top: 12px">
          <button
            class="primary"
            :disabled="!renPreview || renPreview.errors.length > 0"
            @click="doRenumber"
          >一次写成（可回退）</button>
          <button @click="renumberOpen = false">取消</button>
          <div class="spacer" />
          <span class="small muted">写入一半出错会自动整份回退；重复点不会把前缀接两遍。</span>
        </div>
      </section>
    </div>

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
            :tag-for="tagFor"
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
            <b>{{ tagFor(p.instanceId) ?? '?' }} · {{ p.code }}</b>
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
          <h4>选中：{{ selected.code }}</h4>
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
.alert.info {
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  color: #1e40af;
}
.renumber-panel {
  margin-bottom: 12px;
}
.surface-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 8px 0;
}
.cab-grid {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-top: 4px;
}
.cab-grid th,
.cab-grid td {
  border: 1px solid var(--c-line-soft);
  padding: 3px 8px;
  text-align: left;
}
.cab-grid th {
  background: #f6f8f5;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(20, 28, 24, 0.45);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 5vh 16px;
  z-index: 100;
  overflow-y: auto;
}
.modal {
  width: min(720px, 100%);
  background: #fff;
  padding: 18px 20px;
}
.form-grid {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr;
  gap: 10px;
  margin: 10px 0;
}
.form-grid label {
  font-size: 12px;
  color: var(--c-ink-2);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-grid input {
  padding: 6px 8px;
  font-size: 14px;
}
.policy-box {
  border: 1px solid var(--c-line);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #fbfcfb;
}
.policy {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.55;
  cursor: pointer;
  border-radius: 6px;
  padding: 6px 8px;
}
.policy.on {
  background: #fff7ed;
  outline: 1.5px solid var(--c-primary);
}
.preview-box {
  margin-top: 10px;
  border: 1px dashed var(--c-line);
  border-radius: 8px;
  padding: 8px 10px;
  background: #fff;
}
.ov-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  margin-top: 4px;
}
.bad-text {
  color: var(--c-bad);
  font-weight: 700;
}
.warn-text {
  color: #92600a;
  font-weight: 700;
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
