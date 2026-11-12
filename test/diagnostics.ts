import type { Problem } from '../src/problem'

// parser fixtures describe diagnostics; span regressions have separate assertions.
export const diagnostics = (problems: Problem[]): Problem[] => problems.map(({ output: _output, ...p }) => p)
