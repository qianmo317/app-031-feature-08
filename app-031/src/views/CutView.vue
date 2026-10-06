<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { getJob } from '../lib/store'
import { countSawOps } from '../lib/cuts'
import { printJob } from '../lib/print'
import SheetDiagram from '../components/SheetDiagram.vue'
import { cutReplay, tagText } from '../lib/numbering'

const route = useRoute()
const job = computed(() => getJob(route.params.id as string))
const result = computed(() => job.value?.result)

const activeSheet = ref(0)
const sheet = computed(() => result.value?.sheets[activeSheet.value])
const cur = ref(-1)
const playing = ref(false)
const speed = ref(700) // ms / 刀
let timer: number | null = null

const totalSteps = computed(() => sheet.value?.steps.length ?? 0)
const sawOps = computed(() => (result.value ? countSawOps(result.value.sheets) : 0))
const partCount = computed(
  () => result.value?.sheets.reduce((a, s) => a + s.placements.length, 0) ?? 0
)

const currentStep = computed(() =>
  cur.value >= 0 && sheet.value ? sheet.value.steps[cur.value] : null
)

/** 逐刀回看：按贯通切割顺序，每一刀落下去切出哪一件、这件当前是什么号 */
const replay = computed(() => (job.value ? cutReplay(job.value) : null))
const currentProduced = computed(() => {
  if (!replay.value || !sheet.value || cur.value < 0) return []
  return (
    replay.value.cuts.find(
      (c) => c.sheetIndex === sheet.value!.index && c.order === cur.value
    )?.produced ?? []
  )
})
function lookupTag(instanceId: string): string {
  return tagText(job.value, instanceId)
}

function stopTimer(): void {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}
function tick(): void {
  if (cur.value >= totalSteps.value - 1) {
    playing.value = false
    stopTimer()
    return
  }
  cur.value++
}
function play(): void {
  if (cur.value >= totalSteps.value - 1) cur.value = -1
  playing.value = true
}
function pause(): void {
  playing.value = false
}
function reset(): void {
  playing.value = false
  cur.value = -1
}
watch(playing, (v) => {
  stopTimer()
  if (v) timer = window.setInterval(tick, speed.value)
})
watch(speed, () => {
  if (playing.value) {
    stopTimer()
    timer = window.setInterval(tick, speed.value)
  }
})
watch(activeSheet, () => reset())
onBeforeUnmount(stopTimer)

function jumpTo(i: number): void {
  playing.value = false
  cur.value = i
}
function cutsAt(st: { order: number }): { full: string }[] {
  if (!replay.value || !sheet.value) return []
  return replay.value.cuts.find(
    (c) => c.sheetIndex === sheet.value!.index && c.order === st.order
  )?.produced ?? []
}
function printCut(): void {
  if (job.value) printJob(job.value.id, ['cut'])
}
</script>

<template>
  <div v-if="job && result && sheet">
    <section class="panel ctrl-bar">
      <select v-model.number="activeSheet" style="width: 220px">
        <option v-for="s in result.sheets" :key="s.index" :value="s.index">
          第 {{ s.index + 1 }} 张 · {{ s.boardName }}（{{ s.steps.length }} 刀）
        </option>
      </select>
      <button class="sm" @click="reset">⏮ 复位</button>
      <button class="sm" @click="cur = Math.max(-1, cur - 1)">上一刀</button>
      <button v-if="!playing" class="sm primary" @click="play">▶ 播放</button>
      <button v-else class="sm" @click="pause">⏸ 暂停</button>
      <button class="sm" @click="cur = Math.min(totalSteps - 1, cur + 1)">下一刀</button>
      <label class="row small" style="gap: 6px">
        速度
        <input type="range" min="180" max="1600" step="20" v-model.number="speed" style="width: 130px" />
      </label>
      <div class="spacer" />
      <span class="tag">车间实际工步 {{ sawOps }}（{{ partCount }} 件，同向已连续排程）</span>
      <button class="sm" @click="printCut">打印裁切步骤表</button>
    </section>

    <div class="cut-layout">
      <section class="panel">
        <div class="cut-headline" :class="{ trim: currentStep?.kind === 'trim' }">
          <template v-if="currentStep">
            <b>
              第 {{ currentStep.order + 1 }} 刀
              （{{ currentStep.kind === 'trim' ? '修边' : '贯通裁切' }}）：
            </b>
            {{ currentStep.label }}
            <span v-if="currentProduced.length" class="produced">
              → 本刀切出：
              <span v-for="p in currentProduced" :key="p.instanceId" class="produced-chip">
                {{ p.full }}（{{ p.code }} {{ p.name }}）
              </span>
            </span>
            <span v-else class="muted"> → 本刀不直接切出整件（修边/分条）</span>
          </template>
          <template v-else>
            <b>准备就绪</b>
            <span class="muted"> 点「播放」从修边刀开始，灰线 = 已下刀，红线 = 当前刀；每刀切出的件号与标签一致。</span>
          </template>
        </div>
        <div class="svg-wrap">
          <SheetDiagram
            :sheet="sheet"
            :show-cuts="true"
            :active-step="cur"
            :tag-lookup="lookupTag"
          />
        </div>
        <input
          type="range"
          :min="-1"
          :max="totalSteps - 1"
          v-model.number="cur"
          @input="playing = false"
          style="width: 100%"
        />
      </section>

      <aside class="panel step-list no-print">
        <h4>刀序清单（{{ totalSteps }}）</h4>
        <div
          v-for="st in sheet.steps"
          :key="st.order"
          class="step-row"
          :class="{ active: st.order === cur, trim: st.kind === 'trim' }"
          @click="jumpTo(st.order)"
        >
          <span class="n">{{ st.order + 1 }}</span>
          <span class="t">
            {{ st.label }}
            <em v-if="cutsAt(st).length" class="cut-tags">
              {{ cutsAt(st).map((p) => p.full).join('、') }}
            </em>
          </span>
        </div>
      </aside>
    </div>
  </div>
  <div v-else class="panel empty">
    <p>该项目还没有排样结果。</p>
    <router-link :to="`/parts/${route.params.id}`"><button class="primary">去排样</button></router-link>
  </div>
</template>

<style scoped>
.ctrl-bar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.cut-layout {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: 12px;
  align-items: start;
}
.cut-headline {
  font-size: 15px;
  padding: 9px 12px;
  background: #fef2f2;
  border: 1px solid #f3c6c6;
  border-radius: 6px;
  margin-bottom: 10px;
}
.cut-headline.trim {
  background: #fffbeb;
  border-color: #f0d9b5;
}
.svg-wrap {
  border: 1px solid var(--c-line);
  border-radius: 6px;
  background: #fff;
  padding: 8px;
}
.step-list {
  max-height: calc(100vh - 120px);
  overflow-y: auto;
}
.step-list h4 {
  font-size: 13px;
  margin-bottom: 8px;
}
.step-row {
  display: flex;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  align-items: baseline;
  border-left: 3px solid transparent;
}
.step-row:hover {
  background: #f4f7f3;
}
.step-row.active {
  background: #fef2f2;
  border-left-color: #dc2626;
}
.step-row.trim .n {
  background: #a16207;
}
.step-row .n {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #64748b;
  color: #fff;
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.step-row .t {
  font-size: 12px;
}
.cut-tags {
  display: block;
  font-style: normal;
  font-weight: 700;
  color: var(--c-primary);
  margin-top: 2px;
}
.produced {
  font-weight: 700;
}
.produced-chip {
  display: inline-block;
  background: #fff7ed;
  border: 1px solid #f0d9b5;
  border-radius: 4px;
  padding: 0 6px;
  margin-left: 6px;
  font-weight: 700;
}
.empty {
  text-align: center;
  padding: 50px;
}
@media (max-width: 1000px) {
  .cut-layout {
    grid-template-columns: 1fr;
  }
}
</style>
