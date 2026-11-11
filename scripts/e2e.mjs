// drives real VS Code; see checks below
// needs VS Code or VSCODE_BIN
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const code = process.env.VSCODE_BIN ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
// long path: windows runners hand out RUNNER~1, while the shell reports the full name
const work = realpathSync.native(mkdtempSync(join(tmpdir(), 'gleaner-e2e-')))

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

// glob chars in a folder name
mkdirSync(join(demo, 'src', 'app', '[id]'), { recursive: true })
writeFileSync(join(demo, 'src', 'app', '[id]', 'page.ts'), `export const id: number = 'not a number'\n`)

// modes: old, new, hang
writeFileSync(
  join(demo, 'build.mjs'),
  `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const mode = readFileSync('mode', 'utf8')
writeFileSync('started', '')
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
    // the README screenshot comes from this window
    'workbench.colorTheme': 'Catppuccin Mocha',
    'editor.fontFamily': "'Comic Mono', monospace",
    'editor.fontSize': 15,
    'editor.lineHeight': 1.8,
    'editor.letterSpacing': 0.4,
    'editor.fontLigatures': false,
    'editor.padding.top': 20,
    'editor.glyphMargin': false,
    'editor.lightbulb.enabled': 'off',
    'editor.renderLineHighlight': 'none',
    'editor.guides.indentation': false,
    'editor.guides.bracketPairs': false,
    'editor.stickyScroll.enabled': false,
    'editor.occurrencesHighlight': 'off',
    'editor.matchBrackets': 'never',
    'editor.overviewRulerBorder': false,
    'editor.hideCursorInOverviewRuler': true,
    'editor.scrollbar.vertical': 'hidden',
    'editor.scrollbar.horizontal': 'hidden',
    'breadcrumbs.enabled': false,
    'workbench.activityBar.location': 'hidden',
    'workbench.layoutControl.enabled': false,
    'workbench.navigationControl.enabled': false,
    'workbench.editor.showIcons': false,
    'workbench.editor.editorActionsLocation': 'hidden',
    'workbench.tree.renderIndentGuides': 'none',
    'window.commandCenter': false,
    'window.titleBarStyle': 'native',
    'terminal.integrated.initialHint': false,
    'workbench.colorCustomizations': {
      '[Catppuccin Mocha]': {
        focusBorder: '#00000000',
        'list.focusOutline': '#00000000',
        'list.activeSelectionBackground': '#313244',
        'list.inactiveSelectionBackground': '#313244',
        'titleBar.activeBackground': '#11111b',
        'titleBar.inactiveBackground': '#11111b',
        'titleBar.border': '#00000000',
        'editorGroupHeader.tabsBackground': '#181825',
        'editorGroupHeader.tabsBorder': '#00000000',
        'tab.inactiveBackground': '#181825',
        'tab.border': '#00000000',
        'tab.activeBorderTop': '#f9e2af',
        'editorGroup.border': '#00000000',
        'panel.background': '#181825',
        'panel.border': '#00000000',
        'panelTitle.activeBorder': '#f9e2af',
        'statusBar.background': '#11111b',
        'statusBar.border': '#00000000',
        'statusBar.noFolderBackground': '#11111b',
        'badge.background': '#f9e2af',
        'badge.foreground': '#11111b',
        'activityBarBadge.background': '#f9e2af',
      },
    },
  }),
)

const app = await electron.launch({
  executablePath: code,
  args: [
    `--user-data-dir=${user}`,
    `--extensions-dir=${join(work, 'extensions')}`,
    `--extensionDevelopmentPath=${root}`,
    `--extensionDevelopmentPath=${join(root, 'scripts', 'e2e-theme')}`,
    `--extensionDevelopmentPath=${join(root, 'scripts', 'e2e-ls')}`,
    '--disable-extension=vscode.typescript-language-features',
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
  await page.setViewportSize({ width: 1440, height: 820 })
  await page.waitForSelector('.monaco-workbench', { timeout: 30_000 })
  const logs = join(user, 'logs')
  const activated = () =>
    existsSync(logs) && readdirSync(logs, { recursive: true }).some((f) => f.endsWith('Gleaner.log'))
  // gleaner is up and the prompt's circle shows shell integration is connected
  const ready = async () => {
    for (let i = 0; i < 300 && !activated(); i++) await page.waitForTimeout(100)
    if (!activated()) throw new Error('gleaner never activated')
    await page.locator('.codicon-terminal-decoration-incomplete:visible').first().waitFor({ timeout: 30_000 })
  }
  await page.waitForTimeout(3000)

  await page.keyboard.press('Control+Backquote')
  await ready()
  await page.keyboard.type('tsc -p .')
  await page.keyboard.press('Enter')
  await page.getByText(/5 from terminal/).waitFor({ timeout: 30_000 })

  await page.keyboard.press('ControlOrMeta+Shift+M')
  await page.waitForTimeout(1500)
  // header row, problems, related info
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

  await page.keyboard.press('ControlOrMeta+B')
  // the squiggle sits under the text layer: put the cursor on it, then show the hover
  const squiggle = await page.locator('.squiggly-error').last().boundingBox()
  await page.mouse.click(squiggle.x + squiggle.width / 2, squiggle.y + squiggle.height / 2)
  await page.keyboard.press('ControlOrMeta+K')
  await page.keyboard.press('ControlOrMeta+I')
  await page.locator('.monaco-hover:not(.hidden)').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(800)
  // 2x, so the README image is sharp
  const cdp = await page.context().newCDPSession(page)
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1440, height: 820, scale: 2 },
  })
  writeFileSync(join(root, 'media', 'screenshot.png'), Buffer.from(data, 'base64'))
  console.log('saved media/screenshot.png')

  // rerun from a second terminal
  writeFileSync(
    join(demo, 'src', 'cart.ts'),
    readFileSync(join(demo, 'src', 'cart.ts'), 'utf8').replace("price: '4.50'", 'price: 4.5'),
  )
  await page.keyboard.press('Control+Shift+Backquote')
  await ready()
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

  // older run ends later
  mode('old')
  await page.keyboard.type('node build.mjs')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  mode('new')
  await page.keyboard.press('Control+Shift+Backquote')
  await ready()
  await page.keyboard.type('node build.mjs')
  await page.keyboard.press('Enter')
  await status(5, 'newer run')
  writeFileSync(join(demo, 'release'), '')
  await page.waitForTimeout(3000)
  await status(5, 'older run ending later')

  // Ctrl+C keeps the last result
  mode('hang')
  await page.keyboard.type('node build.mjs')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(3000)
  await status(5, 'ctrl+c')

  // Clear; a running run still publishes
  rmSync(join(demo, 'release'))
  mode('old')
  await page.keyboard.type('node build.mjs')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  await page.keyboard.press('F1')
  await page.keyboard.type('Gleaner: Clear Problems')
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  if (await page.getByText(/from terminal/).count()) {
    console.error(`cleared: status still shows ${await page.getByText(/from terminal/).textContent()}`)
    failed = true
  } else console.log('cleared: nothing from terminal')
  writeFileSync(join(demo, 'release'), '')
  await status(2, 'run going during clear')

  // tsc --watch publishes each pass while it keeps running; ctrl+c keeps the last one
  await page.keyboard.type('tsc --watch -p .')
  await page.keyboard.press('Enter')
  await status(6, 'watch, first pass')
  writeFileSync(join(demo, 'src', 'app', '[id]', 'page.ts'), 'export const id: number = 1\n')
  await status(5, 'watch, after a fix')
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(3000)
  await status(5, 'watch, stopped')

  const gleanerLog = () =>
    readdirSync(logs, { recursive: true })
      .filter((f) => f.endsWith('Gleaner.log'))
      .map((f) => readFileSync(join(logs, f), 'utf8'))
      .join('')
  const runs = (command) => gleanerLog().split(`${command}: exit`).length - 1
  const command = async (title) => {
    await page.keyboard.press('F1')
    await page.keyboard.type(title)
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1000)
  }

  // the watch run already lists these three; a second command reporting them adds nothing
  const before = runs('tsc -p .')
  await page.keyboard.type('tsc -p .')
  await page.keyboard.press('Enter')
  for (let i = 0; i < 150 && runs('tsc -p .') === before; i++) await page.waitForTimeout(100)
  await page.waitForTimeout(500)
  await status(5, 'same errors from two commands')

  // a language server reporting one of them hides gleaner's copy, and dropping it brings it back
  await command('E2E LS: Report')
  await status(4, 'language server reports one')
  await command('E2E LS: Drop')
  await status(5, 'language server drops it')

  // positions follow edits: two lines above cart.ts:7:3, then typing right before it
  const row = async (want, label) => {
    await page.keyboard.press('ControlOrMeta+Shift+M')
    await page.waitForTimeout(800)
    const rows = await page.locator('.markers-panel .monaco-list-row').allInnerTexts()
    if (rows.some((r) => r.includes(want))) console.log(`${label}: ${want}`)
    else {
      console.error(`${label}: want ${want}, rows: ${rows.map((r) => r.replace(/\s+/g, ' ')).join(' / ')}`)
      failed = true
    }
  }
  await page.locator('.view-line').first().click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await row('[Ln 9, Col 3]', 'lines inserted above')
  await page.locator('.view-line').first().click()
  await page.keyboard.press('Control+G')
  await page.keyboard.type('9:3')
  await page.keyboard.press('Enter')
  await page.keyboard.type('x ')
  await row('[Ln 9, Col 5]', 'typed before it')

  // turning off clears everything, including a run that's still going
  rmSync(join(demo, 'release'))
  mode('old')
  await command('Terminal: Focus Terminal')
  rmSync(join(demo, 'started'), { force: true })
  await page.keyboard.type('node build.mjs')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
  if (!existsSync(join(demo, 'started'))) {
    console.error('turned off: node build.mjs never reached the terminal')
    failed = true
  }
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
    // dump the Gleaner log
    for (const log of readdirSync(join(user, 'logs'), { recursive: true }).filter((f) => f.endsWith('Gleaner.log')))
      console.error(`--- ${log}\n${readFileSync(join(user, 'logs', log), 'utf8')}`)
  }
  await app.close()
}
process.exit(failed ? 1 : 0)
