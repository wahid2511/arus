import type { DownloadSegment } from '../../shared/downloadTypes'

export type PlannedSegment = DownloadSegment & {
  /** True while a worker is actively downloading this segment. */
  active: boolean
}

export type SplitResult = {
  /** Existing segment with end shrunk to keep the first half of remaining work. */
  kept: PlannedSegment
  /** New segment covering the stolen tail. */
  stolen: PlannedSegment
}

const DEFAULT_MIN_SEGMENT_BYTES = 512 * 1024

/**
 * Pure planner for IDM-style dynamic segmentation.
 * Starts with one full-file segment and splits the largest remaining range
 * whenever a free connection needs work.
 */
export class DynamicSegmentPlanner {
  private segments: PlannedSegment[] = []
  private nextIndex = 0
  private readonly minSegmentBytes: number
  private readonly totalBytes: number

  constructor(totalBytes: number, minSegmentBytes = DEFAULT_MIN_SEGMENT_BYTES) {
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      throw new Error('totalBytes must be a positive number')
    }
    this.totalBytes = Math.floor(totalBytes)
    this.minSegmentBytes = Math.max(1, Math.floor(minSegmentBytes))
  }

  static fromExisting(
    totalBytes: number,
    segments: DownloadSegment[],
    minSegmentBytes = DEFAULT_MIN_SEGMENT_BYTES
  ): DynamicSegmentPlanner {
    const planner = new DynamicSegmentPlanner(totalBytes, minSegmentBytes)
    planner.segments = segments.map((segment) => ({
      ...segment,
      active: false
    }))
    planner.nextIndex =
      segments.reduce((max, segment) => Math.max(max, segment.index), -1) + 1
    return planner
  }

  /** Seed the planner with a single segment covering the whole file. */
  bootstrap(): PlannedSegment {
    this.segments = [
      {
        index: 0,
        start: 0,
        end: this.totalBytes - 1,
        downloaded: 0,
        active: false
      }
    ]
    this.nextIndex = 1
    return this.segments[0]!
  }

  snapshot(): DownloadSegment[] {
    return this.segments.map(({ index, start, end, downloaded }) => ({
      index,
      start,
      end,
      downloaded
    }))
  }

  plannedSnapshot(): PlannedSegment[] {
    return this.segments.map((segment) => ({ ...segment }))
  }

  getSegments(): readonly PlannedSegment[] {
    return this.segments
  }

  remainingBytes(segment: PlannedSegment): number {
    return Math.max(0, segmentLength(segment) - segment.downloaded)
  }

  isComplete(segment: PlannedSegment): boolean {
    return segment.downloaded >= segmentLength(segment)
  }

  allComplete(): boolean {
    if (this.segments.length === 0) {
      return false
    }
    return this.segments.every((segment) => this.isComplete(segment))
  }

  totalDownloaded(): number {
    return this.segments.reduce((sum, segment) => sum + segment.downloaded, 0)
  }

  markActive(index: number, active: boolean): void {
    const segment = this.segments.find((item) => item.index === index)
    if (segment) {
      segment.active = active
    }
  }

  /**
   * Claim work for an idle worker.
   * Prefers an incomplete inactive segment; otherwise splits the largest
   * remaining range (active or pending) when both halves meet the minimum size.
   */
  claimWork(): PlannedSegment | null {
    const inactive = this.segments
      .filter((segment) => !segment.active && !this.isComplete(segment))
      .sort((a, b) => this.remainingBytes(b) - this.remainingBytes(a))

    if (inactive.length > 0) {
      const chosen = inactive[0]!
      chosen.active = true
      return chosen
    }

    const split = this.splitLargestRemaining()
    if (!split) {
      return null
    }

    split.stolen.active = true
    return split.stolen
  }

  /**
   * Split the segment with the largest remaining byte range in half.
   * Returns null when no segment has enough remaining bytes for two halves
   * that each meet `minSegmentBytes`.
   */
  splitLargestRemaining(): SplitResult | null {
    const candidates = this.segments
      .filter((segment) => this.remainingBytes(segment) >= this.minSegmentBytes * 2)
      .sort((a, b) => this.remainingBytes(b) - this.remainingBytes(a))

    const target = candidates[0]
    if (!target) {
      return null
    }

    return this.splitSegment(target)
  }

  /**
   * Shrink `segment.end` so the active worker keeps the first half of remaining
   * work; create a new segment for the stolen tail.
   */
  splitSegment(segment: PlannedSegment): SplitResult | null {
    const remaining = this.remainingBytes(segment)
    if (remaining < this.minSegmentBytes * 2) {
      return null
    }

    const absoluteCursor = segment.start + segment.downloaded
    const mid = absoluteCursor + Math.floor(remaining / 2)
    const leftEnd = mid - 1
    const rightStart = mid

    if (leftEnd < absoluteCursor || rightStart > segment.end) {
      return null
    }

    const leftRemaining = leftEnd - absoluteCursor + 1
    const rightRemaining = segment.end - rightStart + 1
    if (leftRemaining < this.minSegmentBytes || rightRemaining < this.minSegmentBytes) {
      return null
    }

    const originalEnd = segment.end
    segment.end = leftEnd

    const stolen: PlannedSegment = {
      index: this.nextIndex++,
      start: rightStart,
      end: originalEnd,
      downloaded: 0,
      active: false
    }
    this.segments.push(stolen)

    return { kept: segment, stolen }
  }

  /**
   * Advance downloaded bytes for a segment, clamping to the segment length.
   * Returns the number of bytes actually applied (may be less when the segment
   * end was shrunk by a concurrent split).
   */
  applyDownloaded(index: number, bytes: number): number {
    const segment = this.segments.find((item) => item.index === index)
    if (!segment || bytes <= 0) {
      return 0
    }

    const capacity = this.remainingBytes(segment)
    const applied = Math.min(capacity, bytes)
    segment.downloaded += applied
    return applied
  }

  findByIndex(index: number): PlannedSegment | undefined {
    return this.segments.find((segment) => segment.index === index)
  }

  /** Covers [0, totalBytes-1] without gaps or overlaps. */
  coversFullFile(): boolean {
    if (this.segments.length === 0) {
      return false
    }

    const ordered = [...this.segments].sort((a, b) => a.start - b.start)
    if (ordered[0]!.start !== 0) {
      return false
    }

    let expected = 0
    for (const segment of ordered) {
      if (segment.start !== expected) {
        return false
      }
      if (segment.end < segment.start) {
        return false
      }
      expected = segment.end + 1
    }

    return expected === this.totalBytes
  }
}

export function segmentLength(segment: Pick<DownloadSegment, 'start' | 'end'>): number {
  return segment.end - segment.start + 1
}

export function canSplitRemaining(
  remainingBytes: number,
  minSegmentBytes: number
): boolean {
  return remainingBytes >= minSegmentBytes * 2
}
