import { normalizeCode } from './display'
import type { Problem } from './problem'

export interface Comparison {
  readonly command: string
  readonly complete: boolean
  readonly scope: boolean
  readonly fingerprints: readonly string[]
}

export interface Delta {
  fixed: number
  added: number
}

export function comparison(command: string, problems: readonly Problem[], complete: boolean, scope = true): Comparison {
  return Object.freeze({
    command,
    complete,
    scope,
    fingerprints: Object.freeze(
      problems.map((p) => JSON.stringify([p.file, normalizeCode(p.code), p.message.split('\n')[0]])),
    ),
  })
}

export function compareRuns(previous: Comparison | undefined, current: Comparison): Delta | undefined {
  if (!previous?.complete || !current.complete || !previous.scope || !current.scope) return undefined
  if (previous.command !== current.command) return undefined
  const counts = new Map<string, number>()
  for (const key of previous.fingerprints) counts.set(key, (counts.get(key) ?? 0) + 1)
  let added = 0
  for (const key of current.fingerprints) {
    const left = counts.get(key) ?? 0
    if (left) counts.set(key, left - 1)
    else added++
  }
  return { fixed: [...counts.values()].reduce((sum, n) => sum + n, 0), added }
}
