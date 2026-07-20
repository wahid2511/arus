import { describe, expect, it } from 'vitest'
import {
  canSplitRemaining,
  DynamicSegmentPlanner,
  segmentLength
} from './dynamicSegmentPlanner'

describe('DynamicSegmentPlanner', () => {
  it('bootstraps a single full-file segment', () => {
    const planner = new DynamicSegmentPlanner(10_000_000, 512 * 1024)
    const first = planner.bootstrap()

    expect(first).toEqual({
      index: 0,
      start: 0,
      end: 9_999_999,
      downloaded: 0,
      active: false
    })
    expect(planner.coversFullFile()).toBe(true)
  })

  it('claims the initial segment then splits the largest remaining range', () => {
    const min = 256 * 1024
    const total = min * 8
    const planner = new DynamicSegmentPlanner(total, min)

    planner.bootstrap()
    const first = planner.claimWork()
    expect(first?.index).toBe(0)
    expect(first?.active).toBe(true)

    const second = planner.claimWork()
    expect(second).not.toBeNull()
    expect(second!.index).toBe(1)
    expect(second!.start).toBeGreaterThan(first!.start)
    expect(second!.downloaded).toBe(0)

    expect(planner.getSegments()).toHaveLength(2)
    expect(planner.coversFullFile()).toBe(true)

    const kept = planner.findByIndex(0)!
    expect(kept.end).toBe(second!.start - 1)
    expect(segmentLength(kept) + segmentLength(second!)).toBe(total)
  })

  it('does not split when remaining work is below twice the minimum', () => {
    const min = 512 * 1024
    const planner = new DynamicSegmentPlanner(min * 2 - 1, min)
    planner.bootstrap()

    const first = planner.claimWork()
    expect(first).not.toBeNull()

    const second = planner.claimWork()
    expect(second).toBeNull()
    expect(planner.getSegments()).toHaveLength(1)
    expect(canSplitRemaining(planner.remainingBytes(first!), min)).toBe(false)
  })

  it('reuses an idle worker by stealing the largest unfinished tail', () => {
    const min = 100_000
    const total = 1_000_000
    const planner = new DynamicSegmentPlanner(total, min)
    planner.bootstrap()

    const a = planner.claimWork()!
    const b = planner.claimWork()!

    // Finish segment A completely.
    planner.applyDownloaded(a.index, segmentLength(a))
    planner.markActive(a.index, false)
    expect(planner.isComplete(a)).toBe(true)

    // Simulate B still mid-download with a large remaining tail.
    const bRemainingBefore = planner.remainingBytes(b)
    expect(bRemainingBefore).toBeGreaterThanOrEqual(min * 2)
    const bEndBefore = b.end

    const stolen = planner.claimWork()
    expect(stolen).not.toBeNull()
    expect(stolen!.start).toBe(b.end + 1)
    expect(stolen!.end).toBe(bEndBefore)
    expect(planner.coversFullFile()).toBe(true)
    expect(planner.remainingBytes(b)).toBeLessThan(bRemainingBefore)
  })

  it('clamps applyDownloaded when a concurrent split shrinks the end', () => {
    const min = 50_000
    const planner = new DynamicSegmentPlanner(400_000, min)
    planner.bootstrap()
    const segment = planner.claimWork()!

    planner.applyDownloaded(segment.index, 10_000)
    const split = planner.splitSegment(segment)
    expect(split).not.toBeNull()

    const applied = planner.applyDownloaded(segment.index, 1_000_000)
    expect(applied).toBeLessThanOrEqual(segmentLength(segment))
    expect(segment.downloaded).toBe(segmentLength(segment))
    expect(planner.isComplete(segment)).toBe(true)
  })

  it('restores from persisted segments and marks them inactive', () => {
    const planner = DynamicSegmentPlanner.fromExisting(
      1_000_000,
      [
        { index: 0, start: 0, end: 499_999, downloaded: 100_000 },
        { index: 1, start: 500_000, end: 999_999, downloaded: 0 }
      ],
      64 * 1024
    )

    expect(planner.totalDownloaded()).toBe(100_000)
    expect(planner.coversFullFile()).toBe(true)
    expect(planner.getSegments().every((segment) => !segment.active)).toBe(true)

    const claimed = planner.claimWork()
    // Prefers largest incomplete inactive: segment 1 has more remaining.
    expect(claimed?.index).toBe(1)
  })

  it('reports allComplete only when every segment is finished', () => {
    const planner = new DynamicSegmentPlanner(200_000, 50_000)
    planner.bootstrap()
    const first = planner.claimWork()!
    expect(planner.allComplete()).toBe(false)

    planner.applyDownloaded(first.index, segmentLength(first))
    planner.markActive(first.index, false)
    expect(planner.allComplete()).toBe(true)
  })
})

describe('segmentLength / canSplitRemaining', () => {
  it('computes inclusive length', () => {
    expect(segmentLength({ start: 0, end: 99 })).toBe(100)
  })

  it('requires two full minimum halves to allow a split', () => {
    expect(canSplitRemaining(1_024_000, 512_000)).toBe(true)
    expect(canSplitRemaining(1_023_999, 512_000)).toBe(false)
  })
})
