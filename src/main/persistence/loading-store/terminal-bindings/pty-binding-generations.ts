import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../../../../shared/workspace-layout/terminal-topology/terminal-pane-tree'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { StoreRuntimeState } from '../store-runtime-state'

export type GenerationRuntime = Pick<StoreRuntimeState, 'ptyBindingGenerations'> &
  Partial<Pick<StoreRuntimeState, 'ptyBindingGenerationSequence'>>

const generationKey = (hostId: ExecutionHostId, leafId: string) => `${hostId}\0${leafId}`

export function bumpPtyBindingGeneration(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  leafId: string
): void {
  if (
    !ORCA_LAYOUT_OWNER_IS_MAIN &&
    !runtime.ptyBindingGenerations.has(generationKey(hostId, leafId))
  ) {
    return
  }
  const key = generationKey(hostId, leafId)
  runtime.ptyBindingGenerationSequence =
    Math.max(
      runtime.ptyBindingGenerationSequence ?? 0,
      runtime.ptyBindingGenerations.get(key) ?? 0
    ) + 1
  runtime.ptyBindingGenerations.set(key, runtime.ptyBindingGenerationSequence)
}

/** Undefined until this process writes the pane binding. */
export function ptyBindingGenerationOf(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  leafId: string
): number | undefined {
  return runtime.ptyBindingGenerations.get(generationKey(hostId, leafId))
}

/** Account retries opt a current leaf into the existing fence in window-owned builds too. */
export function trackPtyBindingGeneration(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  leafId: string
): number {
  const key = generationKey(hostId, leafId)
  const value = runtime.ptyBindingGenerations.get(key)
  if (value !== undefined) {
    return value
  }
  runtime.ptyBindingGenerationSequence = (runtime.ptyBindingGenerationSequence ?? 0) + 1
  runtime.ptyBindingGenerations.set(key, runtime.ptyBindingGenerationSequence)
  return runtime.ptyBindingGenerationSequence
}

/** Compare changed layouts only; scalar saves do no work and closed leaves retain no fence entry. */
export function reconcileTrackedPtyBindingGenerations(
  runtime: GenerationRuntime,
  hostId: ExecutionHostId,
  before: WorkspaceSessionState | undefined,
  after: WorkspaceSessionState,
  includeUntrackedRebindings = false
): void {
  if (
    (!includeUntrackedRebindings && runtime.ptyBindingGenerations.size === 0) ||
    before?.terminalLayoutsByTabId === after.terminalLayoutsByTabId
  ) {
    return
  }
  const was = new Map<string, { tabId: string; ptyId?: string; incarnationId?: string }>()
  const now = new Map<string, { tabId: string; ptyId?: string; incarnationId?: string }>()
  const tabIds = new Set([
    ...Object.keys(before?.terminalLayoutsByTabId ?? {}),
    ...Object.keys(after.terminalLayoutsByTabId ?? {})
  ])
  for (const tabId of tabIds) {
    const old = before?.terminalLayoutsByTabId?.[tabId],
      next = after.terminalLayoutsByTabId?.[tabId]
    if (old === next) {
      continue
    }
    for (const [layout, session, target] of [
      [old, before, was],
      [next, after, now]
    ] as const) {
      for (const leafId of collectLayoutLeafIdsInOrder(layout?.root)) {
        if (
          !includeUntrackedRebindings &&
          !runtime.ptyBindingGenerations.has(generationKey(hostId, leafId))
        ) {
          continue
        }
        target.set(leafId, {
          tabId,
          ptyId: layout?.ptyIdsByLeafId?.[leafId],
          incarnationId: session?.terminalPtyIncarnationsByPaneKey?.[`${tabId}:${leafId}`]
        })
      }
    }
  }
  for (const [leafId, next] of now) {
    const old = was.get(leafId)
    const tracked = runtime.ptyBindingGenerations.has(generationKey(hostId, leafId))
    if (
      old?.ptyId !== next.ptyId ||
      (tracked && old && (old.tabId !== next.tabId || old.incarnationId !== next.incarnationId))
    ) {
      bumpPtyBindingGeneration(runtime, hostId, leafId)
    }
  }
  for (const leafId of was.keys()) {
    if (!now.has(leafId)) {
      runtime.ptyBindingGenerations.delete(generationKey(hostId, leafId))
    }
  }
}

export function hasPtyBindingGenerations(
  runtime: Partial<GenerationRuntime>
): runtime is GenerationRuntime {
  return runtime.ptyBindingGenerations !== undefined
}
