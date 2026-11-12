import * as path from 'node:path'
import type { Parser, Problem, Severity } from './problem'
import { fromFileUrl } from './resolve'

const FIELDS = ['file', 'line', 'column', 'endLine', 'endColumn', 'location', 'severity', 'code', 'message'] as const
type Field = (typeof FIELDS)[number]
type Captures = Partial<Record<Field, string>>
type Contribution = Record<string, unknown>

interface Pattern {
  regexp: RegExp
  captures: Partial<Record<Field, number>>
  loop: boolean
}

function object(value: unknown): Contribution | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Contribution) : undefined
}

function entries(value: unknown): Contribution[] {
  return Array.isArray(value) ? value.map(object).filter((item) => item !== undefined) : []
}

interface MatcherContext {
  cwd?: string
  workspaceFolders?: { name: string; path: string }[]
}

export function compileMatchers(contributions: unknown[], context: MatcherContext = {}): Parser[] {
  const matchers = contributions.flatMap((value) => entries(object(value)?.problemMatchers))
  const patterns = contributions.flatMap((value) => entries(object(value)?.problemPatterns))
  const namedMatchers = new Map(matchers.filter((m) => typeof m.name === 'string').map((m) => [m.name, m]))
  const namedPatterns = new Map(patterns.filter((p) => typeof p.name === 'string').map((p) => [p.name, p]))

  const resolveMatcher = (matcher: Contribution, seen = new Set<Contribution>()): Contribution | undefined => {
    if (seen.has(matcher)) return undefined
    seen.add(matcher)
    if (matcher.base === undefined) return matcher
    if (typeof matcher.base !== 'string' || !matcher.base.startsWith('$')) return undefined
    // built-in matchers aren't exposed by extensions
    const base = namedMatchers.get(matcher.base.slice(1))
    const resolved = base && resolveMatcher(base, seen)
    return resolved ? { ...resolved, ...matcher } : undefined
  }

  const resolvePattern = (value: unknown, seen = new Set<string>()): Pattern[] | undefined => {
    if (typeof value === 'string') {
      if (!value.startsWith('$') || seen.has(value)) return undefined
      seen.add(value)
      const named = namedPatterns.get(value.slice(1))
      return named ? resolvePattern(named.patterns ?? named, seen) : undefined
    }
    if (Array.isArray(value)) {
      if (!value.length) return undefined
      const compiled = value.map((item) => compilePattern(item))
      return compiled.every((p) => p !== undefined) ? compiled : undefined
    }
    const pattern = compilePattern(value)
    return pattern ? [pattern] : undefined
  }

  return matchers.flatMap((raw) => {
    const matcher = resolveMatcher(raw)
    if (!matcher || matcher.background !== undefined) return []
    const compiled = resolvePattern(matcher.pattern)
    if (!compiled) return []
    const captures = compiled.map((p) => p.captures)
    if (
      !captures.some((c) => c.file !== undefined) ||
      !captures.some((c) => c.line !== undefined || c.location !== undefined)
    )
      return []
    const source =
      [matcher.source, matcher.owner, matcher.name].find((s): s is string => typeof s === 'string') ?? 'extension'
    const fallback = severity(matcher.severity) ?? 'error'
    const parse = parser(compiled, source, fallback)
    if (matcher.fileLocation === undefined) return [parse]
    return [
      (lines: string[]) =>
        parse(lines).flatMap((p) => {
          const file = matcherFile(p.file, matcher.fileLocation, context)
          return file === undefined ? [] : [{ ...p, file }]
        }),
    ]
  })
}

function matcherFile(file: string, location: unknown, context: MatcherContext): string | undefined {
  const [mode, prefix] = Array.isArray(location) ? location : [location]
  if (!['relative', 'absolute', 'autoDetect'].includes(mode)) return undefined
  if (file.startsWith('file://')) file = path.normalize(fromFileUrl(file))
  if (mode === 'absolute') return path.isAbsolute(file) ? file : undefined
  if (mode === 'autoDetect' && path.isAbsolute(file)) return file
  const folders = context.workspaceFolders ?? []
  const folder =
    folders
      .filter((f) => {
        if (!context.cwd) return false
        const relative = path.relative(f.path, context.cwd)
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      })
      .sort((a, b) => b.path.length - a.path.length)[0] ?? folders[0]
  let unresolved = false
  const base = (typeof prefix === 'string' ? prefix : `\${workspaceFolder}`).replace(
    /\$\{([^}]+)\}/g,
    (_, variable: string) => {
      let value: string | undefined
      if (variable === 'cwd') value = context.cwd
      else if (variable === 'workspaceFolder' || variable === 'workspaceRoot') value = folder?.path ?? context.cwd
      else if (variable.startsWith('workspaceFolder:')) value = folders.find((f) => f.name === variable.slice(16))?.path
      if (value === undefined) unresolved = true
      return value ?? ''
    },
  )
  if (unresolved) return undefined
  const dir = path.isAbsolute(base) ? base : (context.cwd ?? folder?.path)
  return dir ? path.resolve(dir, base, file) : undefined
}

function compilePattern(value: unknown): Pattern | undefined {
  const pattern = object(value)
  if (!pattern || typeof pattern.regexp !== 'string') return undefined
  try {
    const captures: Pattern['captures'] = {}
    for (const field of FIELDS) {
      const index = pattern[field]
      if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) captures[field] = index
    }
    return { regexp: new RegExp(pattern.regexp), captures, loop: pattern.loop === true }
  } catch {
    return undefined
  }
}

function severity(value: unknown): Severity | undefined {
  if (typeof value !== 'string') return undefined
  switch (value.trim().toLowerCase()) {
    case 'error':
    case 'e':
      return 'error'
    case 'warning':
    case 'warn':
    case 'w':
      return 'warning'
    case 'info':
    case 'information':
    case 'i':
    case 'hint':
    case 'note':
      return 'info'
    default:
      return undefined
  }
}

function capture(pattern: Pattern, match: RegExpExecArray, previous: Captures): Captures {
  const data = { ...previous }
  for (const field of FIELDS) {
    const index = pattern.captures[field]
    const value = index === undefined ? undefined : match[index]?.trim()
    if (value === undefined) continue
    if (field === 'message' && data.message !== undefined) data.message += `\n${value}`
    else if (data[field] === undefined) data[field] = value
  }
  return data
}

function matchLine(pattern: Pattern, line: string): RegExpExecArray | null {
  try {
    return pattern.regexp.exec(line)
  } catch {
    // contributed regexes can exhaust the stack on unexpected output
    return null
  }
}

function position(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function problem(data: Captures, source: string, fallback: Severity): Problem | undefined {
  let line = position(data.line)
  let col = position(data.column)
  let endLine = position(data.endLine)
  let endCol = position(data.endColumn)
  if (data.location !== undefined) {
    const parts = data.location.split(',').map((part) => position(part.trim()))
    if (![1, 2, 4].includes(parts.length) || parts.some((part) => part === undefined)) return undefined
    line = parts[0]
    col = parts[1]
    endLine = parts[2]
    endCol = parts[3]
  }
  if (!data.file || line === undefined) return undefined
  return {
    file: data.file,
    line,
    col,
    endLine: endLine ?? (endCol !== undefined ? line : undefined),
    endCol,
    severity: severity(data.severity) ?? fallback,
    code: data.code,
    message: data.message ?? '',
    source,
  }
}

function parser(patterns: Pattern[], source: string, fallback: Severity): Parser {
  return (lines) => {
    const problems: Problem[] = []
    const last = patterns.at(-1)
    if (!last) return problems
    for (let start = 0; start < lines.length; start++) {
      let data: Captures = {}
      let beforeLast: Captures = {}
      let matched = 0
      for (const pattern of patterns) {
        if (start + matched >= lines.length) break
        const match = matchLine(pattern, lines[start + matched])
        if (!match) break
        beforeLast = data
        data = capture(pattern, match, data)
        matched++
      }
      if (matched !== patterns.length) continue
      const found = problem(data, source, fallback)
      if (found) problems.push(found)
      start += matched - 1
      // each loop row inherits the header, not the previous row
      if (last.loop) {
        while (start + 1 < lines.length) {
          const match = matchLine(last, lines[start + 1])
          if (!match) break
          start++
          const found = problem(capture(last, match, beforeLast), source, fallback)
          if (found) problems.push(found)
        }
      }
    }
    return problems
  }
}
