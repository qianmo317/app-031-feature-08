<script setup lang="ts">
import { computed, ref } from 'vue'
import { printState } from '../lib/print'
import { getJob } from '../lib/store'
import boardsData from '../data/boards.json'
import SheetDiagram from './SheetDiagram.vue'
import { money, mm } from '../lib/format'
import { labelOf, attributeCuts } from '../lib/numbering'

const job = computed(() => (printState.jobId ? getJob(printState.jobId) : undefined))
const sections = computed(() => new Set(printState.sections))
const now = computed(() => new Date().toLocaleString('zh-CN'))

/** 标签尺寸：常规写得下件名；紧凑（小不干胶）只写号不写件名，标记照带。 */
const compactLabels = ref(printState.compactLabels)

const allInstances = computed(() => {
  if (!job.value?.result) return []
  return job.value.result.sheets.flatMap((s) => s.placements)
})

/** 每一刀的切出件号（出处 + 几何归属），打印用 */
const cutRowsBySheet = computed(() => {
  if (!job.value?.result) return []
  return job.value.result.sheets.map((s) => ({
    sheet: s,
    cuts: attributeCuts(s, job.value!.kerfMm).rows
  }))
})

const edgeText = (sides: string[]): string => {
  const map: Record<string, string> = { top: '上', bottom: '下', left: '左', right: '右' }
  return sides.map((s) => map[s] ?? s).join('') || '无'
}
const tag = (instanceId: string): string => labelOf(job.value!, instanceId) ?? '?'

interface OrderRow {
  code: string
  name: string
  origLen: number
  origWid: number
  qty: number
  grain: string
  edgeCount: number
  exposed: boolean
  tags: string[] // 该种件占用的重排号（连续段）
}
const cabinetGroups = computed(() => {
  const map = new Map<string, OrderRow[]>()
  for (const p of allInstances.value) {
    const arr = map.get(p.cabinet) ?? []
    const cur = arr.find((r) => r.code === p.code)
    const t = tag(p.instanceId)
    if (cur) {
      cur.qty++
      cur.tags.push(t)
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
        tags: [t]
      })
    map.set(p.cabinet, arr)
  }
  // 每种件号段压缩成「起~止」
  for (const arr of map.values()) {
    for (const r of arr) r.tags = compressTags(r.tags)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))
})

function compressTags(labels: string[]): string[] {
  const sorted = [...labels].sort()
  if (sorted.length <= 2) return sorted
  return [`${sorted[0]} ~ ${sorted[sorted.length - 1]}`]
}

const grainText = (g: string): string =>
  g === 'length' ? '竖纹' : g === 'width' ? '横纹' : '无要求'

const boardByName = (name: string) =>
  job.value?.result?.sheets.find((x) => x.boardName === name)
</script>

<template>
  <div v-if="job" class="print-doc print-only">
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
          <SheetDiagram :sheet="s" :show-cuts="false" print-mode :tag-for="(id) => labelOf(job!, id)" />
        </div>
        <table class="pgrid">
          <thead>
            <tr>
              <th>件号（重排）</th><th>编号</th><th>名称</th><th>柜体</th>
              <th>尺寸(mm)</th><th>纹理</th><th>封边</th><th>见光</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in s.placements" :key="p.instanceId">
              <td><b>{{ tag(p.instanceId) }}</b></td>
              <td>{{ p.code }}</td>
              <td>{{ p.name }}</td>
              <td>{{ p.cabinet }}</td>
              <td>{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</td>
              <td>{{ grainText(p.grain) }}</td>
              <td>{{ p.edgeBands.length }} 边（{{ edgeText(p.edgeBands) }}）</td>
              <td>{{ p.exposed ? '见光' : '' }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>

    <!-- 裁切步骤表 -->
    <div v-if="sections.has('cut')">
      <section
        v-for="entry in cutRowsBySheet"
        :key="'pc' + entry.sheet.index"
        class="print-page"
      >
        <h2>裁切步骤表 · 第 {{ entry.sheet.index + 1 }} 张（{{ entry.sheet.boardName }}）</h2>
        <p class="doc-meta">按顺序下锯；同向刀已连续排程（减少推台翻转）；修边刀可多板叠切。</p>
        <table class="pgrid">
          <thead>
            <tr><th>刀序</th><th>类型</th><th>方向</th><th>位置(mm)</th><th>贯通区间(mm)</th><th>切出件号</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in entry.cuts" :key="r.order">
              <td>{{ r.order + 1 }}</td>
              <td>{{ r.kind === 'trim' ? '修边' : '裁切' }}</td>
              <td>{{ r.axis === 'v' ? '竖刀' : '横刀' }}</td>
              <td>{{ Math.round(entry.sheet.steps[r.order].at) }}</td>
              <td>{{ entry.sheet.steps[r.order].span[0] }} ~ {{ entry.sheet.steps[r.order].span[1] }}</td>
              <td>
                <template v-if="r.kind === 'trim'">整板修边</template>
                <b v-else>{{ r.resolved.map((id) => tag(id)).join('、') || '—' }}</b>
              </td>
              <td>{{ entry.sheet.steps[r.order].label }}</td>
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

        <h3>二、零件明细（按柜体分拣）</h3>
        <div v-for="[cab, list] in cabinetGroups" :key="cab" class="avoid-break">
          <h4>柜体/房间：{{ cab }}（{{ list.reduce((a, r) => a + r.qty, 0) }} 件）</h4>
          <table class="pgrid">
            <thead>
              <tr><th>件号（重排）</th><th>编号</th><th>名称</th><th>尺寸(mm)</th><th>数量</th><th>纹理</th><th>封边</th><th>见光</th></tr>
            </thead>
            <tbody>
              <tr v-for="g in list" :key="g.code">
                <td><b>{{ g.tags.join('、') }}</b></td>
                <td>{{ g.code }}</td>
                <td>{{ g.name }}</td>
                <td>{{ mm(g.origLen) }}×{{ mm(g.origWid) }}</td>
                <td>{{ g.qty }}</td>
                <td>{{ grainText(g.grain) }}</td>
                <td>{{ g.edgeCount }} 边</td>
                <td>{{ g.exposed ? '见光' : '' }}</td>
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

    <!-- 标签（A4 不干胶，每块一张；号 = 结果页/下料单/裁切表统一号） -->
    <div v-if="sections.has('labels')">
      <section class="print-page labels-page" :class="{ compact: compactLabels }">
        <div
          v-for="(p, i) in allInstances"
          :key="'lb' + i"
          class="label-card avoid-break"
        >
          <!-- 小标签：只写号，不写件名；纹理/封边/见光标记照带 -->
          <template v-if="compactLabels">
            <div class="lb-code">{{ tag(p.instanceId) }}</div>
            <div class="lb-dims">{{ mm(p.origLen) }}×{{ mm(p.origWid) }}</div>
            <div class="lb-meta">
              <span v-if="p.grain !== 'none'" class="mark">{{ grainText(p.grain) }}</span>
              <span class="mark">封{{ edgeText(p.edgeBands) }}/{{ p.edgeBands.length }}</span>
              <span v-if="p.exposed" class="mark exp">见光</span>
            </div>
            <div class="lb-cab small">{{ p.cabinet }}</div>
          </template>
          <template v-else>
            <div class="lb-code">{{ tag(p.instanceId) }}</div>
            <div class="lb-name">{{ p.name }}</div>
            <div class="lb-dims">{{ mm(p.origLen) }} × {{ mm(p.origWid) }} mm</div>
            <div class="lb-meta">
              {{ p.cabinet }}
              <span v-if="p.grain !== 'none'" class="mark">｜{{ grainText(p.grain) }}</span>
              ｜ 封边 {{ p.edgeBands.length }} 边（{{ edgeText(p.edgeBands) }}）
              <span v-if="p.exposed" class="mark exp">｜见光</span>
            </div>
          </template>
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
/* 小不干胶：标签缩小到 60×30mm，只写号不写件名 */
.labels-page.compact {
  grid-template-columns: repeat(3, 62mm);
  gap: 3mm;
}
.label-card {
  border: 1.5px solid #000;
  border-radius: 3px;
  padding: 3mm 3.5mm;
  height: 38mm;
  overflow: hidden;
}
.labels-page.compact .label-card {
  height: 30mm;
  padding: 2mm 2.5mm;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 0.6mm;
}
.mark {
  font-weight: 700;
}
.mark.exp {
  color: #b45309;
}
.labels-page.compact .lb-code {
  font-size: 17px;
  line-height: 1.1;
  white-space: nowrap;
}
.labels-page.compact .lb-dims {
  font-size: 13px;
  margin: 0;
}
.labels-page.compact .lb-meta {
  font-size: 10px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.labels-page.compact .lb-cab {
  color: #333;
}
.lb-code {
  font-size: 15px;
  font-weight: 700;
}
.lb-seq {
  font-weight: 400;
  font-size: 11px;
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
</style>
