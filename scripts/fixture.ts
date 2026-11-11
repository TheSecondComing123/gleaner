// records, never checks: read it
// usage: pnpm fixture <case>.txt
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { clean } from '../src/clean'
import { parsers } from '../src/parsers'

for (const txt of process.argv.slice(2)) {
  const parse = parsers[basename(dirname(txt))]
  if (!parse) throw new Error(`no parser for ${txt}`)
  const problems = parse(clean(readFileSync(txt, 'utf8')))
  writeFileSync(txt.replace(/\.txt$/, '.json'), `${JSON.stringify(problems, null, 2)}\n`)
  console.log(`${txt}: ${problems.length} problems`)
}
