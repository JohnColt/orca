import { expect, it, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { savePtySpawnPaneBinding } from '../spawn/spawn-commit-binding'
import { runPtySpawn } from '../spawn/spawn-operation'
import { createRuntimePtySpawnState } from '../runtime/spawn-state'
import { makeRuntimePtySpawnTestDeps } from '../runtime/spawn-preflight-test-deps-fixture'
import { restorePtyIncarnation } from '../provider/ownership-state'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import { accountRestartSnapshot, beginAccountRestartOperation } from './account-restart-owner'
import { resolveEarlyPaneSpawnReservationKey } from './spawn-pane-coordinates'
import { clearPaneSpawnReservation, reservePaneSpawn } from './spawn-reservation'
import {
  fixture,
  admitRuntimeSpawnPane
} from '../../../persistence/loading-store/profile-writing/profile-state-delayed-authority-fixture'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../../persistence/persistence-session-fixtures'
import { releaseStoppedPaneBinding, swapReplacedPaneBinding } from './pane-owner-replacement'
import type { ReplacedPaneOwner } from './replaced-pane-owner'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const worktreeId = 'repo-local::/fixture/local'
const tabId = 'restart-tab'

function replaced(ptyId: string): ReplacedPaneOwner {
  return { ptyId, pane: { worktreeId, tabId, leafId: TEST_LEAF_1, hostId: undefined } }
}

type FixtureStore = Awaited<ReturnType<typeof fixture>>['store']

async function bindRestartPane(store: FixtureStore, ptyId: string, incarnationId: string) {
  const pane = { worktreeId, tabId, leafId: TEST_LEAF_1 }
  await store.persistPtyBinding({ ...pane, ptyId, incarnationId })
  return {
    ...pane,
    tabCreatedAt: store
      .getWorkspaceSession()
      .tabsByWorktree[worktreeId].find((tab) => tab.id === tabId)!.createdAt
  }
}

function beginHostRestart(
  store: FixtureStore,
  pane: Awaited<ReturnType<typeof bindRestartPane>>,
  ptyId: string,
  incarnationId: string
) {
  const { hostEpoch, bindingGeneration } = accountRestartSnapshot(store, undefined, pane)
  return beginAccountRestartOperation({
    requestId: 'request-1',
    attemptId: 'attempt-1',
    hostEpoch,
    pane,
    expected: { kind: 'endpoint', ptyId, incarnationId, bindingGeneration }
  })
}

it('refuses to restart a live incarnation mismatched with the durable pane binding', async () => {
  const { store } = await fixture()
  const ptyId = 'recycled-account-restart-owner'
  const pane = await bindRestartPane(store, ptyId, '11111111-1111-4111-8111-111111111111')
  restorePtyIncarnation(ptyId, '22222222-2222-4222-8222-222222222222')

  expect(() => accountRestartSnapshot(store, undefined, pane)).toThrow(
    'terminal_pane_owner_unverified'
  )
})

it('leaves the original running when the request aborts behind a pane reservation', async () => {
  const { store } = await fixture()
  const pane = await bindRestartPane(store, 'waiting-owner', 'old-incarnation')
  const abort = new AbortController()
  const args = { ...pane, cols: 80, rows: 24, signal: abort.signal }
  const state = createRuntimePtySpawnState({ ...makeRuntimePtySpawnTestDeps(), store }, args)
  state.accountRestartOperation = beginHostRestart(store, pane, 'waiting-owner', 'old-incarnation')
  const key = resolveEarlyPaneSpawnReservationKey(args)!
  const held = reservePaneSpawn(key)
  const restart = runPtySpawn({
    state,
    facts: () => ({ paneKey: makePaneKey(tabId, TEST_LEAF_1), sessionId: undefined }),
    replace: async () => {
      throw new Error('replacement dispatched')
    },
    prepare: async () => {
      throw new Error('spawn prepared')
    },
    commit: async () => {
      throw new Error('spawn committed')
    }
  })
  abort.abort()
  clearPaneSpawnReservation(key, held)
  held.resolve({ id: 'waiting-owner' })

  await expect(restart).rejects.toThrow('client_disconnected')
})

it('clears the stopped binding after a rejected replacement write restores it', async () => {
  const { store, authority } = await fixture()
  const pane = await bindRestartPane(store, 'stopped-owner', 'old-incarnation')
  const operation = beginHostRestart(store, pane, 'stopped-owner', 'old-incarnation')
  operation.stop = 'confirmed-retired'
  const stopped = replaced('stopped-owner')
  const result = { id: 'rejected-replacement', incarnationId: 'new-incarnation' }
  authority.failNextWrite()

  await expect(
    savePtySpawnPaneBinding(
      {
        accountRestartOperation: operation,
        result,
        provider: new LocalPtyProvider(),
        replacedPaneOwner: stopped,
        deps: {}
      },
      {
        store,
        binding: { ...pane, ptyId: result.id, incarnationId: result.incarnationId },
        refusal: 'terminal_pane_owner_changed',
        failureLog: 'rejected test replacement'
      },
      undefined
    )
  ).rejects.toMatchObject({ agentSessionOperationOutcome: 'unknown' })

  await expect(releaseStoppedPaneBinding(store, stopped, operation)).resolves.toBe(true)
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBeUndefined()
})

/** The binding swap must survive the renderer's own pre-connect clear, which strict fences refuse. */
async function expectSwapAfterRendererClear(
  store: FixtureStore,
  oldId: string,
  newId: string
): Promise<void> {
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBeUndefined()
  const binding = { worktreeId, tabId, leafId: TEST_LEAF_1, ptyId: newId, incarnationId: 'inc-new' }
  expect(
    await store.persistPtyBinding({
      ...binding,
      expectedBinding: { ptyId: oldId, incarnationId: 'inc-old' }
    })
  ).toBe(false)
  expect(
    await store.persistPtyBinding(swapReplacedPaneBinding(store, binding, replaced(oldId)))
  ).toBe(true)
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBe(newId)
}

it('swaps a cleared split pane once and refuses a stale replacement after rebinding', async () => {
  const { store } = await fixture()
  const pane = { worktreeId, tabId }
  await store.persistPtyBinding({
    ...pane,
    leafId: TEST_LEAF_1,
    ptyId: 'old',
    incarnationId: 'inc-old'
  })
  await store.persistPtyBinding({ ...pane, leafId: TEST_LEAF_2, ptyId: 'sibling' })
  const layouts = structuredClone(store.getWorkspaceSession().terminalLayoutsByTabId)
  // The mounted restart clears only its own leaf before connecting; a partial map is honored.
  delete layouts[tabId].ptyIdsByLeafId![TEST_LEAF_1]
  store.patchWorkspaceSession({ terminalLayoutsByTabId: layouts })
  await expectSwapAfterRendererClear(store, 'old', 'new')
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_2]
  ).toBe('sibling')

  const binding = { worktreeId, tabId, leafId: TEST_LEAF_1, ptyId: 'late' }
  expect(
    await store.persistPtyBinding(swapReplacedPaneBinding(store, binding, replaced('old')))
  ).toBe(false)
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBe('new')
})

it('commits an SSH replacement to its authoritative partition when the local pane identity collides', async () => {
  const { store } = await fixture()
  const connectionId = 'account-restart-ssh'
  const hostId = toSshExecutionHostId(connectionId)
  const pane = { worktreeId, tabId, leafId: TEST_LEAF_1 }
  await admitRuntimeSpawnPane(store, pane, connectionId)
  await store.persistPtyBinding({ ...pane, ptyId: 'ssh-old', incarnationId: 'inc-ssh-old' }, hostId)
  await store.persistPtyBinding({ ...pane, ptyId: 'local-winner', incarnationId: 'inc-local' })
  await savePtySpawnPaneBinding(
    {
      result: { id: 'ssh-new', incarnationId: 'inc-ssh-new' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a successful durable swap never accesses the cleanup-only provider.
      provider: {} as never,
      replacedPaneOwner: { ptyId: 'ssh-old', pane: { ...pane, hostId } },
      deps: {}
    },
    {
      store,
      binding: { ...pane, ptyId: 'ssh-new', incarnationId: 'inc-ssh-new' },
      refusal: 'terminal_pane_owner_changed',
      failureLog: 'unexpected SSH commit failure'
    },
    connectionId
  )
  expect(
    store.getWorkspaceSession(hostId).terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBe('ssh-new')
  expect(
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId?.[TEST_LEAF_1]
  ).toBe('local-winner')
})
