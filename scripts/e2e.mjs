// Opens a real VS Code window with Gleaner loaded, runs `tsc` in its terminal, and checks
// each error reaches the Problems panel under the right file. Then fixes one error and reruns
// from a second terminal: the old problems must be replaced, not doubled. Last, an older run ending
// after a newer one, and a Ctrl+C before any output, must both leave the newer result. Turning gleaner off
// clears everything, even a run that was still going. Saves docs/screenshot.png.
// usage: pnpm e2e   (needs VS Code in /Applications, or its executable in VSCODE_BIN)
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const code = process.env.VSCODE_BIN ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
const work = mkdtempSync(join(tmpdir(), 'gleaner-e2e-'))

const demo = join(work, 'shop')
mkdirSync(join(demo, 'src'), { recursive: true })
writeFileSync(
  join(demo, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2022' }, include: ['src'] }),
)
writeFileSync(
  join(demo, 'src', 'cart.ts'),
  `export interface Item {
  name: string
  price: number
}

export function total(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price, '0')
}

export const sample: Item = { name: 'tea', price: '4.50' }
`,
)
writeFileSync(
  join(demo, 'src', 'checkout.ts'),
  `import { total, type Item } from './cart'

export function receipt(items: Item[]): string {
  const amount: string = total(items)
  return \`total: \${amount.toFixed(2)}\`
}
`,
)

// A folder with glob characters in its name, like a Next.js route.
mkdirSync(join(demo, 'src', 'app', '[id]'), { recursive: true })
writeFileSync(join(demo, 'src', 'app', '[id]', 'page.ts'), `export const id: number = 'not a number'\n`)

// The same command behaving differently per run: `old` waits for `release` and prints two stacks,
// `new` prints one at once, `hang` prints nothing until Ctrl+C.
writeFileSync(
  join(demo, 'build.mjs'),
  `import { existsSync, readFileSync } from 'node:fs'
const mode = readFileSync('mode', 'utf8')
if (mode === 'hang') setInterval(() => {}, 1000)
else {
  while (mode === 'old' && !existsSync('release')) await new Promise((r) => setTimeout(r, 100))
  console.error(new Error('first').stack)
  if (mode === 'old') console.error(new Error('second').stack)
}
`,
)
const mode = (value) => writeFileSync(join(demo, 'mode'), value)

const user = join(work, 'user')
mkdirSync(join(user, 'User'), { recursive: true })
writeFileSync(
  join(user, 'User', 'settings.json'),
  JSON.stringify({
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'editor.minimap.enabled': false,
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
    'typescript.validate.enable': false,
    'window.zoomLevel': 0,
  }),
)

const app = await electron.launch({
  executablePath: code,
  args: [
    `--user-data-dir=${user}`,
    `--extensions-dir=${join(work, 'extensions')}`,
    `--extensionDevelopmentPath=${root}`,
    '--disable-workspace-trust',
    '--skip-release-notes',
    '--new-window',
    demo,
    join(demo, 'src', 'cart.ts'),
  ],
})

let failed = false
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForSelector('.monaco-workbench', { timeout: 30_000 })
  await page.waitForTimeout(3000)

  await page.keyboard.press('Control+Backquote')
  await page.waitForSelector('.xterm', { timeout: 15_000 })
  // give shell integration time to connect before typing
  await page.waitForTimeout(4000)
  await page.keyboard.type('tsc -p .')
  await page.keyboard.press('Enter')
  await page.getByText(/5 from terminal/).waitFor({ timeout: 30_000 })

  await page.keyboard.press('ControlOrMeta+Shift+M')
  await page.waitForTimeout(1500)
  // Rows come in order: a file header (no position), then its problems (with `tsc`), then related info.
  let file = ''
  const shown = []
  for (const row of await page.locator('.markers-panel .monaco-list-row').allInnerTexts()) {
    const text = row.replace(/\s+/g, ' ').trim()
    if (!text.includes('[Ln')) file = text.match(/^.+?\.ts/)?.[0] ?? text
    else if (text.includes('tsc')) shown.push(`${file} ${text.match(/TS\d+/)?.[0]} ${text.match(/\[Ln.*?\]/)?.[0]}`)
  }
  console.log(`problems panel:\n  ${shown.join('\n  ')}`)
  const expected = [
    'cart.ts TS2322 [Ln 7, Col 3]',
    'cart.ts TS2322 [Ln 10, Col 44]',
    'checkout.ts TS2322 [Ln 4, Col 9]',
    'checkout.ts TS2551 [Ln 5, Col 27]',
    'page.ts TS2322 [Ln 1, Col 14]',
  ]
  for (const want of expected) {
    if (!shown.includes(want)) {
      console.error(`missing from the problems panel: ${want}`)
      failed = true
    }
  }
  if (shown.length !== expected.length) {
    console.error(`expected ${expected.length} tsc problems in the panel, got ${shown.length}`)
    failed = true
  }

  await page.screenshot({ path: join(root, 'docs', 'screenshot.png') })
  console.log('saved docs/screenshot.png')

  // Fix one error, then rerun the same command from a new terminal.
  writeFileSync(
    join(demo, 'src', 'cart.ts'),
    readFileSync(join(demo, 'src', 'cart.ts'), 'utf8').replace("price: '4.50'", 'price: 4.5'),
  )
  await page.keyboard.press('Control+Shift+Backquote')
  await page.waitForTimeout(4000)
  await page.keyboard.type('tsc -p .')
  await page.keyboard.press('Enter')
  try {
    await page.getByText(/4 from terminal/).waitFor({ timeout: 30_000 })
    console.log('rerun from a second terminal: 4 from terminal')
  } catch {
    console.error(
      `rerun should replace the old problems, status shows: ${await page.getByText(/from terminal/).textContent()}`,
    )
    failed = true
  }

  const status = async (want, label) => {
    try {
      await page.getByText(new RegExp(`\\b${want} from terminal`)).waitFor({ timeout: 15_000 })
      console.log(`${label}: ${want} from terminal`)
    } catch {
      console.error(`${label}: want ${want}, status shows ${await page.getByText(/from terminal/).textContent()}`)
      failed = true
    }
  }

  // An older run that ends after a newer run of the same command must not overwrite it.
  mode('old')
  await page.keyboard.type('node build.mjs')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  mode('new')
  await page.keyboard.press('Control+Shift+Backquote')
  await page.waitForTimeout(4000)
  await page.keyboard.type('node build.mjs')
  await page.keyboard.press('Enter')
  await status(5, 'newer run')
  writeFileSync(join(demo, 'release'), '')
  await page.waitForTimeout(3000)
  await status(5, 'older run ending later')

  // Ctrl+C before any output keeps the last result.
  mode('hang')
  await page.keyboard.type('node build.mjs')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(3000)
  await status(5, 'ctrl+c')

  // Turning gleaner off clears its problems, and a run still going when it's turned off adds none.
  rmSync(join(demo, 'release'))
  mode('old')
  await page.keyboard.type('node build.mjs')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  const settings = join(user, 'User', 'settings.json')
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, 'utf8')), 'gleaner.enable': false }))
  await page.waitForTimeout(3000)
  writeFileSync(join(demo, 'release'), '')
  await page.waitForTimeout(3000)
  if (await page.getByText(/from terminal/).count()) {
    console.error(`turned off: status still shows ${await page.getByText(/from terminal/).textContent()}`)
    failed = true
  } else console.log('turned off: nothing from terminal')
} catch (error) {
  console.error(error)
  failed = true
} finally {
  if (failed) {
    await (await app.firstWindow()).screenshot({ path: join(root, 'e2e-failure.png') })
    // Gleaner's output channel says whether a run found nothing or found files it couldn't resolve.
    for (const log of readdirSync(join(user, 'logs'), { recursive: true }).filter((f) => f.endsWith('Gleaner.log')))
      console.error(`--- ${log}\n${readFileSync(join(user, 'logs', log), 'utf8')}`)
  }
  await app.close()
}
process.exit(failed ? 1 : 0)
