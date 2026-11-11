import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clean } from '../src/clean'
import { parsers } from '../src/parsers'

// real output → expected .json
const root = join(__dirname, 'fixtures')

for (const name of readdirSync(root)) {
  describe(name, () => {
    for (const file of readdirSync(join(root, name)).filter((f) => f.endsWith('.txt'))) {
      it(file, () => {
        const parse = parsers[name]
        expect(parse, `no parser named ${name}`).toBeDefined()
        const lines = clean(readFileSync(join(root, name, file), 'utf8'))
        const expected = JSON.parse(readFileSync(join(root, name, file.replace(/\.txt$/, '.json')), 'utf8'))
        expect(parse(lines)).toEqual(expected)
      })
    }
  })
}
