import { parseMarkdown } from './markdown'
import type { Discussion, HistoryEntry, Segment } from './types'

export interface SyncMergeResult {
  segments: Segment[]
  discussions: Discussion[]
  historyEntries: HistoryEntry[]
  added: number
  updated: number
  removed: number
}

interface AlignOp {
  oldIndex?: number
  newIndex?: number
}

// 按原文内容做 LCS 对齐：相同文本视为未变片段，其余先按删除/新增记录。
const alignBySource = (oldTexts: string[], newTexts: string[]): AlignOp[] => {
  const rows = oldTexts.length
  const cols = newTexts.length
  const dp: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0))
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      dp[i][j] = oldTexts[i] === newTexts[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const ops: AlignOp[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (oldTexts[i] === newTexts[j]) {
      ops.push({ oldIndex: i, newIndex: j })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ oldIndex: i })
      i++
    } else {
      ops.push({ newIndex: j })
      j++
    }
  }
  while (i < rows) { ops.push({ oldIndex: i }); i++ }
  while (j < cols) { ops.push({ newIndex: j }); j++ }
  return ops
}

// 将上游新版文档合并进工作区：
// - 原文未变：保留译文、状态、备注与讨论（片段 id 不变）。
// - 原文变更：保留片段 id（讨论不丢），清空译文并转为待处理，改前改后写入历史。
// - 新增片段：空译文、草稿状态进入工作区。
// - 不再存在的片段：移出工作区，其讨论一并移除。
export const mergeUpstreamDocument = (
  current: Segment[],
  discussions: Discussion[],
  upstreamMarkdown: string,
  now = Date.now(),
): SyncMergeResult => {
  const incoming = parseMarkdown(upstreamMarkdown)
  const ops = alignBySource(current.map((segment) => segment.sourceText), incoming.map((segment) => segment.sourceText))

  const segments: Segment[] = []
  const historyEntries: HistoryEntry[] = []
  const removedIds = new Set<string>()
  let added = 0
  let updated = 0
  let removed = 0
  let cursor = 0

  while (cursor < ops.length) {
    const op = ops[cursor]
    if (op.oldIndex !== undefined && op.newIndex !== undefined) {
      segments.push(current[op.oldIndex])
      cursor++
      continue
    }
    // 连续的一段删除 + 新增视为同一处改动，按顺序两两配对为“原文变更”。
    const removedOps: number[] = []
    const addedOps: number[] = []
    while (cursor < ops.length && !(ops[cursor].oldIndex !== undefined && ops[cursor].newIndex !== undefined)) {
      const item = ops[cursor]
      if (item.oldIndex !== undefined) removedOps.push(item.oldIndex)
      else if (item.newIndex !== undefined) addedOps.push(item.newIndex)
      cursor++
    }
    const changedCount = Math.min(removedOps.length, addedOps.length)
    for (let k = 0; k < changedCount; k++) {
      const previous = current[removedOps[k]]
      const next = incoming[addedOps[k]]
      segments.push({
        ...previous,
        kind: next.kind,
        sourceText: next.sourceText,
        targetText: '',
        status: 'needs-work',
        protectedTokens: next.protectedTokens,
      })
      historyEntries.push({
        id: `history-sync-${now}-${previous.id}`,
        segmentId: previous.id,
        author: '源文同步',
        action: 'sync',
        before: previous.sourceText,
        after: next.sourceText,
        createdAt: now,
      })
      updated++
    }
    for (let k = changedCount; k < removedOps.length; k++) {
      removedIds.add(current[removedOps[k]].id)
      removed++
    }
    for (let k = changedCount; k < addedOps.length; k++) {
      const block = incoming[addedOps[k]]
      segments.push({ ...block, id: `segment-sync-${now}-${added + 1}` })
      added++
    }
  }

  return {
    segments: segments.map((segment, index) => ({ ...segment, index: index + 1 })),
    discussions: discussions.filter((discussion) => !removedIds.has(discussion.segmentId)),
    historyEntries,
    added,
    updated,
    removed,
  }
}
