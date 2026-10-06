import { reactive } from 'vue'

export type PrintSection = 'nest' | 'cut' | 'order' | 'labels'

interface PrintState {
  jobId: string | null
  sections: PrintSection[]
  compactLabels: boolean // 标签小到写不下件名时：只写号不写件名
}

export const printState = reactive<PrintState>({
  jobId: null,
  sections: ['nest', 'cut', 'order', 'labels'],
  compactLabels: false
})

export function printJob(jobId: string, sections: PrintSection[], compactLabels = false): void {
  printState.jobId = jobId
  printState.sections = sections
  printState.compactLabels = compactLabels
  // 等打印文档渲染完再唤起打印
  setTimeout(() => window.print(), 60)
}
