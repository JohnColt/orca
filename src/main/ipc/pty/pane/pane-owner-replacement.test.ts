import { expect, it, onTestFinished, vi } from 'vitest'
import { toSshExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { getDefaultSettings } from '../../../../shared/orca-profiles/constants'
import { savePtySpawnPaneBinding } from '../spawn/spawn-commit-binding'
import { runPtySpawn } from '../spawn/spawn-operation'
import { createRuntimePtySpawnState } from '../runtime/spawn-state'
import { makeRuntimePtySpawnTestDeps } from '../runtime/spawn-preflight-test-deps-fixture'
import { restorePtyIncarnation } from '../provider/ownership-state'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import { DaemonPtyRouter } from '../../../daemon/providers/routing/daemon-pty-router'
import { createAdapter } from '../../../daemon/providers/routing/testing/daemon-pty-router-test-fixture'
import { PROTOCOL_VERSION } from '../../../daemon/protocol/daemon-protocol-version'
import { resolveAccountRestartPane } from '../../../runtime/terminal/recovery/account-restart-pane-snapshot'
import { runPtyIpcSpawn } from '../ipc/spawn-run'
import { stopReplacedPanePty } from '../ipc/renderer-kill'
import { getLocalPtyProvider, setLocalPtyProvider } from '../provider/registry'
import { spawnPtyFromRuntimeController } from '../runtime/spawn'
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

function localRestartProvider(): LocalPtyProvider {
  const previous = getLocalPtyProvider()
  const provider = new LocalPtyProvider()
  setLocalPtyProvider(provider)
  onTestFinished(() => setLocalPtyProvider(previous))
  return provider
}

function rendererRestartDeps(deps: ReturnType<typeof makeRuntimePtySpawnTestDeps>) {
  return {
    ...deps,
    getSettings: () => deps.getSettings?.() ?? getDefaultSettings('/tmp'),
    transitionSpawnHiddenRendererPtyDeliveryState: () => {},
    syncPtyBackgroundedDelivery: () => {},
    stopReplacedPty: (id: string, incarnation?: string, authorize?: () => void) =>
      stopReplacedPanePty(deps, id, incarnation, authorize)
  }
}

function restartPane(store: FixtureStore) {
  const pane = { worktreeId, tabId, leafId: TEST_LEAF_1 }
  return {
    ...pane,
    tabCreatedAt: store
      .getWorkspaceSession()
      .tabsByWorktree[worktreeId].find((tab) => tab.id === tabId)!.createdAt
  }
}

async function bindRestartPane(store: FixtureStore, ptyId: string, incarnationId: string) {
  const pane = { worktreeId, tabId, leafId: TEST_LEAF_1 }
  await admitRuntimeSpawnPane(store, pane)
  await store.persistPtyBinding({ ...pane, ptyId, incarnationId })
  return restartPane(store)
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

it('answers restart identity for an exact incarnation without returning the launch token', async () => {
  const { store } = await fixture()
  const pane = await bindRestartPane(store, 'bound-restart-pty', 'bound-incarnation')
  const paneKey = makePaneKey(pane.tabId, pane.leafId)
  const pty = {
    ptyId: 'bound-restart-pty',
    incarnationId: 'bound-incarnation',
    launchIncarnationId: 'bound-incarnation',
    launchToken: 'internal-token'
  }
  const runtime = {
    resolveTerminalWorkspaceLaunchScope: vi.fn().mockResolvedValue({ id: worktreeId }),
    resolveTerminalPane: () => ({
      ...pty,
      handle: 'bound-handle',
      tabId: pane.tabId,
      leafId: pane.leafId,
      connected: true
    })
  }
  const matching = await resolveAccountRestartPane(
    runtime,
    store,
    paneKey,
    worktreeId,
    () => pty,
    'internal-token'
  )
  const different = await resolveAccountRestartPane(
    runtime,
    store,
    paneKey,
    worktreeId,
    () => pty,
    'other-token'
  )
  expect(matching.accountRestart?.attempt).toBe('matching')
  expect(different.accountRestart?.attempt).toBe('different')
  expect(matching).not.toHaveProperty('launchToken')
  expect(different).not.toHaveProperty('launchToken')
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

it.each(['runtime', 'renderer'] as const)(
  'keeps the original running when the %s stop loses its pane generation during provider startup',
  async (entryPoint) => {
    const provider = localRestartProvider()
    const providerStarted = Promise.withResolvers<void>()
    const releaseStartup = Promise.withResolvers<void>()
    const retire = vi.fn()
    vi.spyOn(provider, 'killFenced').mockImplementation(async (_request, authorize) => {
      authorize?.()
      retire()
      return { outcome: 'ended' }
    })
    const { store } = await fixture()
    const pane = await bindRestartPane(store, 'delayed-stop', 'original-incarnation')
    const { condition } = beginHostRestart(store, pane, 'delayed-stop', 'original-incarnation')
    const deps = {
      ...makeRuntimePtySpawnTestDeps(),
      store,
      getLocalPtyProviderStartupPromise: () => {
        providerStarted.resolve()
        return releaseStartup.promise
      }
    }
    const args = { ...pane, cols: 80, rows: 24, accountRestart: condition }
    const pending =
      entryPoint === 'runtime'
        ? spawnPtyFromRuntimeController(deps, args)
        : runPtyIpcSpawn(rendererRestartDeps(deps), args)
    const rejection = expect(pending).rejects.toThrow('terminal_pane_owner_changed')
    try {
      await providerStarted.promise
      await store.persistPtyBinding({ ...pane, ptyId: 'intervening', incarnationId: 'other' })
      await store.persistPtyBinding({
        ...pane,
        ptyId: 'delayed-stop',
        incarnationId: 'original-incarnation'
      })
    } finally {
      releaseStartup.resolve()
    }
    await rejection
    expect(retire).not.toHaveBeenCalled()
  }
)

async function emptyRestartPane(store: FixtureStore) {
  await admitRuntimeSpawnPane(store, { worktreeId, tabId, leafId: TEST_LEAF_1 })
  const pane = restartPane(store)
  const { hostEpoch, bindingGeneration } = accountRestartSnapshot(store, undefined, pane)
  return {
    ...pane,
    cols: 80,
    rows: 24,
    accountRestart: {
      requestId: 'request-new-account',
      attemptId: 'expected-attempt',
      hostEpoch,
      pane,
      expected: { kind: 'empty' as const, bindingGeneration }
    }
  }
}

it('sends the restart attempt to the provider despite a request to delete its environment key', async () => {
  const provider = localRestartProvider()
  const spawn = vi.spyOn(provider, 'spawn').mockResolvedValue({
    id: 'fresh-account-process',
    incarnationId: 'fresh-account-incarnation'
  })
  const { store } = await fixture()
  const args = await emptyRestartPane(store)
  await runPtyIpcSpawn(rendererRestartDeps({ ...makeRuntimePtySpawnTestDeps(), store }), {
    ...args,
    env: { ORCA_AGENT_LAUNCH_TOKEN: 'old-attempt', DROP_THIS: 'requested' },
    envToDelete: ['ORCA_AGENT_LAUNCH_TOKEN', 'DROP_THIS']
  })
  const launch = spawn.mock.calls[0]?.[0]
  expect(launch?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBe('expected-attempt')
  expect(launch?.env?.DROP_THIS).toBeUndefined()
  expect(launch?.envToDelete).not.toContain('ORCA_AGENT_LAUNCH_TOKEN')
})

it('refuses to commit an existing provider session as a fresh account restart', async () => {
  const provider = localRestartProvider()
  const spawn = vi.spyOn(provider, 'spawn').mockResolvedValue({
    id: 'previous-account-process',
    incarnationId: 'previous-account-incarnation',
    isReattach: true
  })
  const { store } = await fixture()
  const args = await emptyRestartPane(store)
  const deps = rendererRestartDeps({ ...makeRuntimePtySpawnTestDeps(), store })

  await expect(
    runPtyIpcSpawn(deps, { ...args, sessionId: 'previous-account-process' })
  ).rejects.toThrow('invalid_account_restart')
  expect(spawn).not.toHaveBeenCalled()
  await expect(runPtyIpcSpawn(deps, args)).rejects.toThrow(
    'terminal_account_restart_outcome_unknown'
  )
  const layout = store.getWorkspaceSession().terminalLayoutsByTabId[tabId]
  expect(layout.ptyIdsByLeafId?.[TEST_LEAF_1]).toBeUndefined()
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

it('retries a confirmed retirement after both replacement and cleanup writes fail', async () => {
  const { store, authority } = await fixture()
  const oldId = 'twice-restored-retired-owner'
  const pane = await bindRestartPane(store, oldId, 'old-incarnation')
  const operation = beginHostRestart(store, pane, oldId, 'old-incarnation')
  operation.stop = 'confirmed-retired'
  const stopped = replaced(oldId)
  const result = { id: 'failed-first-replacement', incarnationId: 'first-incarnation' }
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
        failureLog: 'test replacement write'
      },
      undefined
    )
  ).rejects.toThrow()
  authority.failNextWrite()
  await expect(releaseStoppedPaneBinding(store, stopped, operation)).resolves.toBe(false)
  expect(accountRestartSnapshot(store, undefined, pane).owner).toEqual({
    ptyId: oldId,
    incarnationId: 'old-incarnation'
  })

  const priorProvider = getLocalPtyProvider()
  const adapter = createAdapter('current', [], undefined, PROTOCOL_VERSION)
  vi.mocked(adapter.spawn).mockImplementation(async (opts) => ({
    id: opts.sessionId!,
    incarnationId: 'retry-incarnation'
  }))
  setLocalPtyProvider(new DaemonPtyRouter({ current: adapter, legacy: [] }))
  onTestFinished(() => setLocalPtyProvider(priorProvider))
  const deps = rendererRestartDeps({ ...makeRuntimePtySpawnTestDeps(), store })
  const retry = await runPtyIpcSpawn(deps, {
    ...pane,
    cols: 80,
    rows: 24,
    accountRestart: {
      ...operation.condition,
      attemptId: 'retry-attempt',
      expected: {
        kind: 'endpoint',
        ptyId: oldId,
        incarnationId: 'old-incarnation',
        bindingGeneration: accountRestartSnapshot(store, undefined, pane).bindingGeneration
      }
    }
  })
  expect(retry.incarnationId).toBe('retry-incarnation')
  expect(accountRestartSnapshot(store, undefined, pane).owner?.ptyId).toBe(retry.id)
  expect(adapter.killFenced).not.toHaveBeenCalled()
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
