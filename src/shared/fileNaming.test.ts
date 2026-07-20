import { describe, expect, it } from 'vitest'
import {
  clampConnections,
  clampMaxConcurrentDownloads,
  clampMaxSegmentRetries,
  clampMinSegmentSizeBytes
} from './fileNaming'

describe('settings clamps', () => {
  it('clamps connections to 4–16', () => {
    expect(clampConnections(2)).toBe(4)
    expect(clampConnections(8)).toBe(8)
    expect(clampConnections(99)).toBe(16)
    expect(clampConnections(Number.NaN)).toBe(8)
  })

  it('clamps concurrent downloads to 1–10', () => {
    expect(clampMaxConcurrentDownloads(0)).toBe(1)
    expect(clampMaxConcurrentDownloads(3)).toBe(3)
    expect(clampMaxConcurrentDownloads(50)).toBe(10)
  })

  it('clamps min segment size to 64 KiB–8 MiB', () => {
    expect(clampMinSegmentSizeBytes(1024)).toBe(64 * 1024)
    expect(clampMinSegmentSizeBytes(512 * 1024)).toBe(512 * 1024)
    expect(clampMinSegmentSizeBytes(100 * 1024 * 1024)).toBe(8 * 1024 * 1024)
  })

  it('clamps segment retries to 0–10', () => {
    expect(clampMaxSegmentRetries(-1)).toBe(0)
    expect(clampMaxSegmentRetries(3)).toBe(3)
    expect(clampMaxSegmentRetries(99)).toBe(10)
  })
})
