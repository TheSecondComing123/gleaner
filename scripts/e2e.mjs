// Opens a real VS Code window with Gleaner loaded, runs `tsc` in its terminal, and
// checks that the errors reach the Problems panel. Saves docs/screenshot.png.
// usage: pnpm e2e   (needs VS Code in /Applications)
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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

  const status = page.getByText(/\d+ from terminal/)
  await status.waitFor({ timeout: 30_000 })
  const text = (await status.textContent()) ?? ''
  console.log(`status bar: ${text}`)

  await page.keyboard.press('Meta+Shift+M')
  await page.waitForTimeout(1500)
  const rows = await page.locator('.markers-panel .monaco-list-row').allInnerTexts()
  console.log(`problems panel:\n  ${rows.join('\n  ')}`)

  const count = Number(text.match(/(\d+) from terminal/)?.[1])
  if (count !== 4) {
    console.error(`expected 4 problems from tsc, got ${count}`)
    failed = true
  }

  await page.screenshot({ path: join(root, 'docs', 'screenshot.png') })
  console.log('saved docs/screenshot.png')
} catch (error) {
  console.error(error)
  failed = true
} finally {
  await app.close()
}
process.exit(failed ? 1 : 0)
