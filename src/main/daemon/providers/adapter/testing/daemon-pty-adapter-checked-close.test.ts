import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import { getHistorySessionDirName } from '../../../history/storage/history-paths'

let harness: DaemonAdapterHarness | undefined
let adapter: DaemonPtyAdapter | undefined
let subprocess: ReturnType<typeof createMockSubprocess>

async function start(Provider = DaemonPtyAdapter): Promise<DaemonPtyAdapter> {
  harness = await startDaemonAdapterHarness(() => {
    subprocess = createMockSubprocess()
    return subprocess
  })
  harness.adapter.dispose()
  adapter = new Provider({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    historyPath: join(harness.dir, 'history')
  })
  return adapter
}

function historyTree(id: string): string {
  return join(harness!.dir, 'history', getHistorySessionDirName(id))
}

function checkedRequest(id: string, expectedIncarnationId: string) {
  return { id, expectedIncarnationId, requireNoAgentOwner: false, requireUnattached: false }
}

async function spawn(provider: DaemonPtyAdapter, id = 'checked-close') {
  const result = await provider.spawn({ sessionId: id, cols: 80, rows: 24 })
  if (!result.incarnationId) {
    throw new Error('Expected incarnation')
  }
  return { ...result, incarnationId: result.incarnationId }
}

afterEach(async () => {
  adapter?.dispose()
  await harness?.server.shutdown()
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
  adapter = undefined
  harness = undefined
  vi.restoreAllMocks()
})

describe('DaemonPtyAdapter checked explicit close', () => {
  it.each(['ended', 'already_exited'] as const)(
    'removes the real history tree after %s',
    async (outcome) => {
      const provider = await start()
      const created = await spawn(provider)
      const tree = historyTree(created.id)
      expect(existsSync(join(tree, 'meta.json'))).toBe(true)
      if (outcome === 'already_exited') {
        subprocess._simulateExit(0)
        await waitFor(() => !provider.hasPty(created.id))
        expect(provider.getHistoryManager()!.readMeta(created.id)?.endedAt).toBeTruthy()
      }

      await expect(
        provider.killFenced(checkedRequest(created.id, created.incarnationId))
      ).resolves.toEqual({ outcome })

      expect(existsSync(tree)).toBe(false)
      expect(provider.getHistoryManager()!.hasWriter(created.id)).toBe(false)
      expect(provider.hasPty(created.id)).toBe(false)
      await expect(spawn(provider, created.id)).rejects.toThrow('was explicitly killed')
    }
  )

  it('retains history and the live session on a checked refusal', async () => {
    const provider = await start()
    const created = await spawn(provider)
    const tree = historyTree(created.id)
    const meta = readFileSync(join(tree, 'meta.json'), 'utf8')

    await expect(
      provider.killFenced(checkedRequest(created.id, 'predecessor-incarnation'))
    ).resolves.toEqual({ outcome: 'refused', reason: 'replaced' })

    expect(readFileSync(join(tree, 'meta.json'), 'utf8')).toBe(meta)
    expect(provider.getHistoryManager()!.hasWriter(created.id)).toBe(true)
    expect(provider.hasPty(created.id)).toBe(true)
    expect(subprocess.forceKill).not.toHaveBeenCalled()
  })

  it('preserves output before the first periodic checkpoint during fenced retirement', async () => {
    class FinalCheckpointOnlyAdapter extends DaemonPtyAdapter {
      protected override scheduleCheckpointTimer(): void {}
    }
    const provider = await start(FinalCheckpointOnlyAdapter)
    const created = await spawn(provider)
    subprocess._simulateData('final restart screen\r\n')

    await expect(
      provider.killFenced({
        ...checkedRequest(created.id, created.incarnationId),
        keepHistory: true
      })
    ).resolves.toEqual({ outcome: 'ended' })

    const checkpoint = JSON.parse(
      readFileSync(join(historyTree(created.id), 'checkpoint.json'), 'utf8')
    )
    expect(checkpoint.snapshotAnsi).toContain('final restart screen')
    expect(provider.getHistoryManager()!.readMeta(created.id)?.endedAt).toBeNull()
  })

  it('keeps preserving live history after a fenced stop is refused', async () => {
    const provider = await start()
    const created = await spawn(provider)
    const request = { ...checkedRequest(created.id, created.incarnationId), keepHistory: true }

    await expect(provider.killFenced({ ...request, requireUnattached: true })).resolves.toEqual({
      outcome: 'refused',
      reason: 'attached'
    })
    subprocess._simulateData('output after refused restart\r\n')
    await expect(provider.killFenced(request)).resolves.toEqual({ outcome: 'ended' })

    const checkpoint = JSON.parse(
      readFileSync(join(historyTree(created.id), 'checkpoint.json'), 'utf8')
    )
    expect(checkpoint.snapshotAnsi).toContain('output after refused restart')
  })

  it('holds the lifecycle lock through checked history removal', async () => {
    const provider = await start()
    const created = await spawn(provider)
    const manager = provider.getHistoryManager()!
    const originalRemove = manager.removeSession.bind(manager)
    let removing = false
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    vi.spyOn(manager, 'removeSession').mockImplementation(async (id) => {
      removing = true
      await held
      await originalRemove(id)
    })
    const closing = provider.killFenced(checkedRequest(created.id, created.incarnationId))
    await waitFor(() => removing)
    const reopening = provider.spawn({ sessionId: created.id, cols: 80, rows: 24 })
    // Handle rejection before releasing the lock to avoid an unhandled promise rejection.
    const reopened = expect(reopening).rejects.toThrow('was explicitly killed')
    expect(existsSync(historyTree(created.id))).toBe(true)
    release()

    await expect(closing).resolves.toEqual({ outcome: 'ended' })
    await reopened
    expect(existsSync(historyTree(created.id))).toBe(false)
  })
})
