export type Severity = 'error' | 'warning' | 'info'

export interface Related {
  file: string
  line: number
  col?: number
  message: string
}

export interface OutputSpan {
  start: number
  end: number
}

export interface Problem {
  output?: OutputSpan
  file: string
  line: number
  col?: number
  endLine?: number
  endCol?: number
  severity: Severity
  message: string
  code?: string
  source: string
  related?: Related[]
}

export type Parser = (lines: string[]) => Problem[]
