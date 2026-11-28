import { describe, expect, it } from 'vitest'
import { canonicalizeArgs, createRepeatGuard } from '../src/loop-guard.js'

describe('canonicalizeArgs', () => {
  it('sorts object keys recursively so equivalent payloads produce identical keys', () => {
    expect(canonicalizeArgs({ b: 2, a: { y: 1, x: [3, { d: 4, c: 5 }] } }))
      .toBe(canonicalizeArgs({ a: { x: [3, { c: 5, d: 4 }], y: 1 }, b: 2 }))
  })
})

describe('createRepeatGuard', () => {
  it('emits gentle reminder at 3rd consecutive call and detailed reminders at 5th and 8th', () => {
    const guard = createRepeatGuard()
    expect(guard.observe('browser_click', { target: 'Submit' })).toBeNull()
    expect(guard.observe('browser_click', { target: 'Submit' })).toBeNull()

    const third = guard.observe('browser_click', { target: 'Submit' })
    expect(third).toContain('repeating the exact same tool call')
    expect(third).not.toContain('consecutive_calls:')

    expect(guard.observe('browser_click', { target: 'Submit' })).toBeNull()

    const fifth = guard.observe('browser_click', { target: 'Submit' })
    expect(fifth).toContain('tool: browser_click')
    expect(fifth).toContain('consecutive_calls: 5')
    expect(fifth).toContain('{"target":"Submit"}')

    expect(guard.observe('browser_click', { target: 'Submit' })).toBeNull()
    expect(guard.observe('browser_click', { target: 'Submit' })).toBeNull()

    const eighth = guard.observe('browser_click', { target: 'Submit' })
    expect(eighth).toContain('consecutive_calls: 8')
  })

  it('treats reordered object keys as identical calls and resets when tool or args change', () => {
    const guard = createRepeatGuard()
    expect(guard.observe('shell', { cmd: 'ls', timeoutMs: 5000 })).toBeNull()
    expect(guard.observe('shell', { timeoutMs: 5000, cmd: 'ls' })).toBeNull()
    expect(guard.observe('shell', { cmd: 'ls', timeoutMs: 5000 })).toContain('repeating')

    // Changing args resets the chain
    expect(guard.observe('shell', { cmd: 'pwd' })).toBeNull()
    expect(guard.observe('shell', { cmd: 'ls', timeoutMs: 5000 })).toBeNull()
    expect(guard.observe('shell', { cmd: 'ls', timeoutMs: 5000 })).toBeNull()
    expect(guard.observe('shell', { cmd: 'ls', timeoutMs: 5000 })).toContain('repeating')
  })

  it('truncates oversized canonical arguments in detailed reminders', () => {
    const guard = createRepeatGuard({ thresholds: [2, 3], previewChars: 20 })
    const big = { content: 'x'.repeat(200) }
    expect(guard.observe('write_file', big)).toBeNull()
    expect(guard.observe('write_file', big)).toContain('repeating')
    const detailed = guard.observe('write_file', big)!
    expect(detailed).toContain('consecutive_calls: 3')
    expect(detailed).toMatch(/… \(\+\d+ more chars\)/)
    expect(detailed.length).toBeLessThan(400)
  })

  it('keeps the raw call identity while previewing only redacted arguments', () => {
    const guard = createRepeatGuard({ thresholds: [2, 3] })
    const args = { target: 'private-workflow-value' }
    const preview = { target: '[private workflow value]' }
    expect(guard.observe('browser_click', args, preview)).toBeNull()
    expect(guard.observe('browser_click', args, preview)).toContain('repeating')
    const detailed = guard.observe('browser_click', args, preview)!
    expect(detailed).toContain('{"target":"[private workflow value]"}')
    expect(detailed).not.toContain('private-workflow-value')
  })
})
