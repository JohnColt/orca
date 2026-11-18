// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Translate } from '@/i18n/use-translate'
import type { WorkerAutoCloseState } from '../../../../../shared/orchestration/workers/worker-auto-close'
import { PaneTopBanner } from '../appearance/pane-top-banner/PaneTopWarningBanner'
import { workerAutoCloseBannerProps } from './worker-auto-close-banner'

const t: Translate = (_key, fallback, options) =>
  fallback.replace('{{countdown}}', String(options?.countdown ?? ''))

const RUNNING: WorkerAutoCloseState = { kept: false, closesAt: null }
const FINISHED: WorkerAutoCloseState = { kept: false, closesAt: '2026-11-17T12:02:00.000Z' }

function bannerAt(state: WorkerAutoCloseState, nowIso: string): React.JSX.Element {
  const props = workerAutoCloseBannerProps(state, Date.parse(nowIso), () => {}, t)
  if (!props) {
    throw new Error('expected a banner')
  }
  return <PaneTopBanner {...props} />
}

afterEach(cleanup)

describe('worker auto-close banner live region', () => {
  it('announces the running title from a single status region', () => {
    const { container } = render(bannerAt(RUNNING, '2026-11-17T12:00:00.000Z'))

    const [status, ...others] = screen.getAllByRole('status')
    expect(others).toHaveLength(0)
    expect(status.textContent).toBeTruthy()
    expect(container.querySelector('p')?.textContent).toContain(status.textContent)
  })

  it('keeps one status node from running to finished, then holds it still while the countdown ticks', () => {
    const { rerender } = render(bannerAt(RUNNING, '2026-11-17T12:00:00.000Z'))
    const status = screen.getByRole('status')
    const runningText = status.textContent

    rerender(bannerAt(FINISHED, '2026-11-17T12:00:18.000Z'))
    expect(screen.getByText(/1:42/)).toBeTruthy()
    expect(screen.getByRole('status')).toBe(status)
    const finishedText = status.textContent
    expect(finishedText).not.toBe(runningText)

    rerender(bannerAt(FINISHED, '2026-11-17T12:00:19.000Z'))
    expect(screen.getByText(/1:41/)).toBeTruthy()
    expect(screen.getByRole('status')).toBe(status)
    expect(status.textContent).toBe(finishedText)
    expect(finishedText).not.toMatch(/1:4\d/)
  })
})
