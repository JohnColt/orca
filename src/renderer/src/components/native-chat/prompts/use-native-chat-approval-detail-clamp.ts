import { useLayoutEffect, useState, type RefObject } from 'react'

/** Whether the folded detail overflows its line clamp, re-measured as the pane width changes. */
export function useNativeChatApprovalDetailClamp(
  detailRef: RefObject<HTMLDivElement | null>,
  detail: string | undefined,
  detailOpen: boolean
): boolean {
  const [detailClamped, setDetailClamped] = useState(false)
  useLayoutEffect(() => {
    const node = detailRef.current
    if (!node || detailOpen) {
      return undefined
    }
    const measure = (): void => setDetailClamped(node.scrollHeight > node.clientHeight + 1)
    measure()
    // A narrower pane can wrap a short command past the clamp.
    if (typeof ResizeObserver === 'undefined') {
      return undefined
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [detailRef, detail, detailOpen])
  return detailClamped
}
