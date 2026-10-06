<script setup lang="ts">
import { computed } from 'vue'
import { printState } from '../lib/print'
import { getJob } from '../lib/store'
import boardsData from '../data/boards.json'
import SheetDiagram from './SheetDiagram.vue'
import { money, mm } from '../lib/format'
import {
  orderedInstances,
  compactTagRanges,
  cutReplay,
  groupRange,
  tagText
} from '../lib/numbering'

const job = computed(() => (printState.jobId ? getJob(printState.jobId) : undefined))
const sections = computed(() => new Set(printState.sections))
const now = computed(() => new Date().toLocaleString('zh-CN'))

const allInstances = computed(() => {
  if (!job.value?.result) return []
  return orderedInstances(job.value.result)
})

function tagOf(instanceId: string): string {
  return tagText(job.value, instanceId)
}

interface OrderRow {
  code: string
  name: string
  origLen: number
  origWid: number
  qty: number
  grain: string
  edgeCount: number
  exposed: boolean
  instances: { instanceId: string }[]
  tagRanges: string
}
const cabinetGroups = computed(() => {
  const map = new Map<string, OrderRow[]>()
  for (const p of allInstances.value) {
    const arr = map.get(p.cabinet) ?? []
    // 同柜体同件名归并（编码作次级键，避免同名不同编码被并到一起）
    const cur = arr.find((r) => r.code === p.code && r.name === p.name)
    if (cur) {
      cur.qty++
      cur.instances.push({ instanceId: p.instanceId })
    } else
      arr.push({
        code: p.code,
        name: p.name,
        origLen: p.origLen,
        origWid: p.origWid,
        qty: 1,
        grain: p.grain,
        edgeCount: p.edgeBands.length,
        exposed: p.exposed,
        instances: [{ instanceId: p.instanceId }],
        tagRanges: ''
      })
    map.set(p.cabinet, arr)
  }
  if (job.value?.numbering)
    for (const arr of map.values())
      for (const r of arr) r.tagRanges = compactTagRanges(job.value.numbering, r.instances)
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
})

/** 材料统计/下料单统一使用的按柜件数与号段（与逐件号同源）。 */
const statsByCabinet = computed(() =>
  (job.value?.numbering?.groups ?? []).map((g) => ({
    cabinet: g.cabinet,
    count: g.count,
    range: job.value?.numbering ? groupRange(job.value.numbering, g) : '',
    overflowCount: g.overflowCount
  }))
)

/** 逐刀回看结果：每刀切出哪几件、号是什么（裁切步骤表用） */
const replay = computed(() => (job.value ? cutReplay(job.value) : null))
function cutsProduced(sheetIndex: number, order: number): string {
  const c = replay.value?.cuts.find((x) => x.sheetIndex === sheetIndex && x.order === order)
  if (!c || c.produced.length === 0) return '—'
  return c.produced.map((p) => `${p.full}（${p.code}）`).join('、')
}

const grainText = (g: string): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无要求'
const grainMark = (g: string): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无纹'

const boardByName = (name: string) =>
  job.value?.result?.sheets.find((x) => x.boardName === name)

function tagLookup(instanceId: string): string {
  return tagOf(instanceId)
}
</script>

<template>
  <div v-if="job" class="print-doc print-only">
    <div v-if="(sections.has('nest') || sections.has('labels') || sections.has('order') || sections.has('cut')) && job.numbering?.source === 'default'" class="doc-banner">
      本批件号为旧项目读取后按默认规则（前缀为空、3 位、每柜 1 起）重排生成，非原始老号。
    </div>
    <!-- 排样图 -->
    <div v-if="sections.has('nest')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pn' + s.index"
        class="print-page"
      >
        <h2>排样图 · 第 {{ s.index + 1 }} 张 / 共 {{ job.result?.sheets.length }} 张</h2>
        <p class="doc-meta">
          {{ s.boardName }}（{{ s.material }} {{ s.thicknessMm }}mm） · 尺寸
          {{ s.wMm }}×{{ s.hMm }}mm · 利用率 {{ (s.utilization * 100).toFixed(1) }}% ·
          锯路 {{ job.kerfMm }}mm · 修边 {{ job.trimMm }}mm
        </p>
        <div class="print-sheet-wrap">
          <SheetDiagram :sheet="s" :show-cuts="false" print-mode :tag-lookup="tagLookup" />
        </div>
        <table class="pgrid">
          <thead>
            <tr>
              <th>件号</th><th>编码</th><th>名称</th><th>柜体</th>
              <th>尺寸(mm)</th><th>纹理</th><th>封边</th><th>见光</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in s.placements" :key="p.instanceId">
              <td class="cell-tag">{{ tagOf(p.instanceId) }}</td>
              <td>{{ p.code }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.cabinet }}</td>
              <td>{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</td>
              <td>{{ grainText(p.grain) }}</td>
              <td>{{ p.edgeBands.length }} 边</td>
              <td>{{ p.exposed ? '是' : '' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 裁切步骤表 -->
    <div v-if="sections.has('cut')">
      <section
        v-for="s in job.result?.sheets ?? []"
        :key="'pc' + s.index"
        class="print-page"
      >
        <h2>裁切步骤表 · 第 {{ s.index + 1 }} 张（{{ s.boardName }}）</h2>
        <p class="doc-meta">
          按顺序下锯；同向刀已连续排程（减少推台翻转）；修边刀可多板叠切。
          「本刀切出」与排样图、标签、下料单使用同一套件号（已逐刀核对）。
        </p>
        <table class="pgrid">
          <thead>
            <tr><th>刀序</th><th>类型</th><th>方向</th><th>位置(mm)</th><th>贯通区间(mm)</th><th>本刀切出（件号/编码）</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="st in s.steps" :key="st.order">
              <td>{{ st.order + 1 }}</td>
              <td>{{ st.kind === 'trim' ? '修边' : '裁切' }}</td>
              <td>{{ st.axis === 'v' ? '竖刀' : '横刀' }}</td>
              <td>{{ Math.round(st.at) }}</td>
              <td>{{ st.span[0] }} ~ {{ st.span[1] }}</td>
              <td class="cell-tag">{{ cutsProduced(s.index, st.order) }}</td>
              <td>{{ st.label }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 下料单 / 领料单 -->
    <div v-if="sections.has('order')">
      <section class="print-page">
        <h2>下料单 / 领料单</h2>
        <p class="doc-meta">项目：{{ job.name }} ｜ 打印时间：{{ now }}</p>

        <h3>一、板材领料</h3>
        <table class="pgrid">
          <thead>
            <tr><th>板材</th><th>规格(mm)</th><th>厚度</th><th>张数</th><th>单价</th><th>小计</th></tr>
          </thead>
          <tbody>
            <tr v-for="(n, name) in job.result?.boardsByType" :key="name">
              <td>{{ name }}</td>
              <td>{{ boardByName(String(name))?.wMm }}×{{ boardByName(String(name))?.hMm }}</td>
              <td>{{ boardByName(String(name))?.thicknessMm }}</td>
              <td>{{ n }}</td>
              <td>{{ money(boardByName(String(name))?.priceCents ?? 0) }}</td>
              <td>{{ money((boardByName(String(name))?.priceCents ?? 0) * Number(n)) }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td colspan="5">板材合计</td>
              <td>{{ money(job.result?.totalCostCents ?? 0) }}</td>
            </tr>
          </tfoot>
        </table>

        <h3>二、零件明细（按柜体分拣，件号与图/标签一致）</h3>
        <table class="pgrid" style="margin-bottom: 8px">
          <thead>
            <tr><th>柜体/房间</th><th>件数</th><th>件号号段</th></tr>
          </thead>
          <tbody>
            <tr v-for="g in statsByCabinet" :key="g.cabinet">
              <td>{{ g.cabinet }}</td>
              <td>{{ g.count }}</td>
              <td class="cell-tag">{{ g.range }}</td>
            </tr>
          </tbody>
        </table>
        <div v-for="[cab, list] in cabinetGroups" :key="cab" class="avoid-break">
          <h4>柜体/房间：{{ cab }}（{{ list.reduce((a, r) => a + r.qty, 0) }} 件）</h4>
          <table class="pgrid">
            <thead>
              <tr><th>件号（号段）</th><th>编码</th><th>名称</th><th>尺寸(mm)</th><th>数量</th><th>纹理</th><th>封边</th><th>见光</th></tr>
            </thead>
            <tbody>
              <tr v-for="g in list" :key="g.code + g.name">
                <td class="cell-tag">{{ g.tagRanges }}</td>
                <td>{{ g.code }}</td>
                <td>{{ g.name }}</td>
                <td>{{ mm(g.origLen) }}×{{ mm(g.origWid) }}</td>
                <td>{{ g.qty }}</td>
                <td>{{ grainText(g.grain) }}</td>
                <td>{{ g.edgeCount }} 边</td>
                <td>{{ g.exposed ? '是' : '' }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3>三、封边与五金辅料</h3>
        <table class="pgrid">
          <tbody>
            <tr><td>见光边封边</td><td>{{ job.result?.edgeBandM.exposed }} m</td></tr>
            <tr><td>非见光边封边</td><td>{{ job.result?.edgeBandM.normal }} m</td></tr>
            <tr><td>{{ boardsData.hardware.connectorName }}</td><td>{{ allInstances.length * boardsData.hardware.connectorPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.dowelName }}</td><td>{{ allInstances.length * boardsData.hardware.dowelPerPart }}</td></tr>
            <tr><td>{{ boardsData.hardware.screwName }}</td><td>{{ allInstances.length * boardsData.hardware.screwPerPart }}</td></tr>
            <tr>
              <td>{{ boardsData.hardware.glueName }}</td>
              <td>{{ ((((job.result?.edgeBandM.exposed ?? 0) + (job.result?.edgeBandM.normal ?? 0)) * boardsData.hardware.glueGramPerEdgeMeter) / 1000).toFixed(2) }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 标签（A4 不干胶，每块一张；小标签只写号不写件名） -->
    <div v-if="sections.has('labels')">
      <section class="print-page labels-page">
        <div
          v-for="p in allInstances"
          :key="'lb' + p.instanceId"
          class="label-card avoid-break"
          :class="{ compact: (tagOf(p.instanceId) || p.code).length >= 14 }"
        >
          <div class="lb-code">
            {{ tagOf(p.instanceId) }}
            <span class="lb-rawcode">{{ p.code }}</span>
          </div>
          <div v-if="(tagOf(p.instanceId) || p.code).length < 14" class="lb-name">{{ p.name }}</div>
          <div class="lb-dims">{{ mm(p.origLen) }} × {{ mm(p.origWid) }} mm</div>
          <div class="lb-meta">
            <span class="lb-mark">{{ grainMark(p.grain) }}</span>
            ｜ 封边 {{ p.edgeBands.length }} 边
            <template v-if="p.exposed">｜ <b>见光</b></template>
            ｜ {{ p.cabinet }}
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.print-doc {
  color: #000;
  font-size: 12px;
}
.print-doc h2 {
  font-size: 17px;
  margin-bottom: 6px;
}
.print-doc h3 {
  font-size: 14px;
  margin: 14px 0 6px;
}
.print-doc h4 {
  font-size: 13px;
  margin: 10px 0 4px;
}
.doc-meta {
  color: #333;
  margin: 0 0 8px;
  font-size: 11px;
}
.doc-banner {
  border: 1px solid #92600a;
  background: #fffbeb;
  color: #7a4d07;
  padding: 6px 10px;
  margin-bottom: 10px;
  font-size: 11px;
}
.cell-tag {
  font-weight: 700;
  white-space: nowrap;
}
.print-sheet-wrap {
  border: 1px solid #888;
  padding: 6px;
  margin-bottom: 10px;
}
table.pgrid {
  width: 100%;
  border-collapse: collapse;
  font-size: 10.5px;
}
table.pgrid th,
table.pgrid td {
  border: 1px solid #555;
  padding: 2.5px 5px;
  text-align: left;
}
table.pgrid th {
  background: #eee;
}
.labels-page {
  display: grid;
  grid-template-columns: repeat(2, 94mm);
  gap: 4mm 6mm;
  justify-content: center;
}
.label-card {
  border: 1.5px solid #000;
  border-radius: 3px;
  padding: 3mm 3.5mm;
  height: 38mm;
  overflow: hidden;
}
.label-card.compact .lb-code {
  font-size: 13px;
}
.lb-code {
  font-size: 15px;
  font-weight: 700;
  display: flex;
  justify-content: space-between;
  gap: 6px;
}
.lb-rawcode {
  font-weight: 400;
  font-size: 10px;
  color: #444;
}
.lb-name {
  font-size: 12px;
  margin: 1mm 0;
}
.lb-dims {
  font-size: 18px;
  font-weight: 700;
  margin: 1mm 0;
}
.lb-meta {
  font-size: 10.5px;
}
.lb-mark {
  font-weight: 700;
}
</style>
