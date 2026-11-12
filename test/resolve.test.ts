import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapPath } from '../src/resolve'

const folders = [{ name: 'shop', path: resolve('/repo/shop') }]
const multi = [...folders, { name: 'other', path: resolve('/repo/other') }]

describe('path mappings', () => {
  it('matches whole components, including an exact prefix', () => {
    const mappings = { '/app/src': 'src' }
    expect(mapPath('/app/src/a.ts', mappings, folders)).toEqual({
      path: resolve('/repo/shop/src/a.ts'),
      target: 'src/a.ts',
    })
    expect(mapPath('/app/src', mappings, folders)).toEqual({ path: resolve('/repo/shop/src'), target: 'src' })
    expect(mapPath('/app/srcx/a.ts', mappings, folders)).toBeUndefined()
    expect(mapPath('/other/app/src/a.ts', mappings, folders)).toBeUndefined()
    expect(mapPath('/app/src/a.ts', {}, folders)).toBeUndefined()
    expect(mapPath('/app/src/a.ts', { '': 'src' }, folders)).toBeUndefined()
  })

  it('uses the longest prefix regardless of setting order', () => {
    const mappings = { '/app': 'wrong', '/app/src': 'src' }
    for (const ordered of [mappings, Object.fromEntries(Object.entries(mappings).reverse())]) {
      expect(mapPath('/app/src/a.ts', ordered, folders)).toEqual({
        path: resolve('/repo/shop/src/a.ts'),
        target: 'src/a.ts',
      })
    }
  })

  it.each([
    ['C:\\build\\src\\a.ts', 'C:/build/src', 'src'],
    ['C:/build/src/a.ts', 'C:\\build\\src\\', 'src'],
    ['/app/src\\lib/a.ts', '/app/src/', 'src\\nested'],
  ])('accepts either separator in %s', (file, prefix, target) => {
    const suffix = file.includes('lib') ? 'src/nested/lib/a.ts' : 'src/a.ts'
    expect(mapPath(file, { [prefix]: target }, folders)).toEqual({
      path: resolve('/repo/shop', suffix),
      target: suffix,
    })
  })

  it('supports a root prefix and a workspace-root target', () => {
    expect(mapPath('/src/a.ts', { '/': '.' }, folders)).toEqual({
      path: resolve('/repo/shop/src/a.ts'),
      target: 'src/a.ts',
    })
    expect(mapPath('/tmp/build/copy/a.ts', { '/tmp/build/copy': `\${workspaceFolder}` }, folders)).toEqual({
      path: resolve('/repo/shop/a.ts'),
      target: `\${workspaceFolder}/a.ts`,
    })
  })

  it('uses a named folder in a multi-root workspace', () => {
    expect(mapPath('/app/a.ts', { '/app': `\${workspaceFolder:other}/src` }, multi)).toEqual({
      path: resolve('/repo/other/src/a.ts'),
      target: `\${workspaceFolder:other}/src/a.ts`,
    })
  })

  it.each(['src', '.', `\${workspaceFolder}/src`, `\${workspaceFolder:missing}/src`])(
    'ignores ambiguous or unknown workspace targets: %s',
    (target) => {
      expect(mapPath('/app/a.ts', { '/app': target }, multi)).toEqual({
        error: expect.stringContaining(`use \${workspaceFolder:name}`),
      })
    },
  )

  it('ignores relative targets without a workspace', () => {
    expect(mapPath('/app/a.ts', { '/app': 'src' }, [])).toEqual({ error: expect.stringContaining('workspace folder') })
    expect(mapPath('/app/a.ts', { '/app': `\${workspaceFolder}` }, [])).toEqual({
      error: expect.stringContaining('workspace folder'),
    })
  })

  it('allows absolute targets without choosing a workspace folder', () => {
    for (const roots of [[], multi]) {
      expect(mapPath('/app/a.ts', { '/app': resolve('/source') }, roots)).toEqual({
        path: resolve('/source/a.ts'),
        target: `${resolve('/source').replace(/\\/g, '/')}/a.ts`,
      })
    }
  })

  it('handles windows workspace paths and absolute targets on any host', () => {
    const windows = [{ name: 'shop', path: 'C:\\repo\\shop' }]
    expect(mapPath('/app/a.ts', { '/app': 'src' }, windows)).toMatchObject({ path: 'C:\\repo\\shop\\src\\a.ts' })
    expect(mapPath('/app/a.ts', { '/app': 'D:\\source' }, multi)).toMatchObject({ path: 'D:\\source\\a.ts' })
    expect(mapPath('/app/a.ts', { '/app': `\${workspaceFolder}/src` }, windows)).toMatchObject({
      path: 'C:\\repo\\shop\\src\\a.ts',
    })
  })

  it('maps decoded file URLs too', () => {
    expect(mapPath('file:///app/src/a%20b.ts', { '/app/src': 'src' }, folders)).toMatchObject({
      path: resolve('/repo/shop/src/a b.ts'),
    })
  })
})
