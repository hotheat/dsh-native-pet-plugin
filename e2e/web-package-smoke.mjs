import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const dsh = process.env.DSH_BIN ?? 'dsh'
const repository = fileURLToPath(new URL('..', import.meta.url))
let tarball = process.env.DSH_NATIVE_PET_TARBALL ? resolve(process.env.DSH_NATIVE_PET_TARBALL) : undefined
const home = await mkdtemp(join(tmpdir(), 'dsh-pet-web-install-'))
const output = process.env.DSH_NATIVE_PET_PACKAGE_EVIDENCE
  ? resolve(process.env.DSH_NATIVE_PET_PACKAGE_EVIDENCE)
  : join(await mkdtemp(join(tmpdir(), 'dsh-pet-package-evidence-')), 'package-evidence.json')
const env = { ...process.env, DSH_HOME: home, DSH_NATIVE_PET_RUNTIME_DIR: join(home, 'pet-runtime') }
const steps = []
let owner
async function command(args) {
  const result = await execute(dsh, args, { env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  steps.push({ command: ['dsh', ...args], stdout: args.includes('--dump-config')
    ? `Composed config: ${Buffer.byteLength(result.stdout)} bytes; native-pet entry present=${/id: native-pet/.test(result.stdout)}`
    : result.stdout, stderr: result.stderr })
  return result.stdout
}
const manifestPath = join(home, 'profiles/web/package.json')
const manifest = async () => JSON.parse(await readFile(manifestPath, 'utf8'))
try {
  if (!tarball) {
    const packed = await execute('npm', ['pack', '--json', '--pack-destination', home], {
      cwd: repository, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    })
    tarball = join(home, JSON.parse(packed.stdout)[0].filename)
  }
  await command(['plugin', '--profile', 'web', 'add', tarball, '--ignore-scripts', '--store-dir', join(home, 'pnpm-store'), '--config.fetch-retries=0', '--config.fetch-timeout=20000'])
  const installed = await manifest()
  assert.ok(installed.dependencies?.['dsh-native-pet'])
  assert.ok(installed.dsh.profile.bundles.includes('dsh-native-pet'))
  const installedConfig = await command(['--profile', 'web', '--dump-config'])
  assert.match(installedConfig, /native-pet/)

  // CLI plugin forwards pnpm; use the same public service as Web for bundle enablement.
  const executable = dsh.includes('/') ? dsh : (await execute('which', [dsh])).stdout.trim()
  const binary = await realpath(executable)
  const requireDsh = createRequire(join(dirname(dirname(binary)), 'package.json'))
  const appBoot = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { default: PluginManager } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-plugin-manager')).href)
  const dir = dirname(manifestPath)
  const anchor = join(dirname(dirname(binary)), 'package.json')
  const profile = {
    name: 'web', dir, home, installAnchor: anchor, cwd: home,
    patchPath: join(dir, 'cordis.patch.yml'), startedBundles: [...installed.dsh.profile.bundles],
    overlays: [], telemetryDisabledEnv: undefined,
  }
  const configPath = join(home, 'package-smoke.cordis.yml')
  await writeFile(configPath, '[]\n')
  owner = await appBoot.boot('dsh-pet-package-smoke', configPath,
    [{ insert: [{ id: 'package-smoke-manager', name: 'cordis:package-smoke-manager' }] }], ctx => {
      ctx.provide('profileContext', profile)
      ctx.provide('appReady', { onReady: listener => { listener(); return () => {} } })
      ctx.loader.builtins['package-smoke-manager'] = PluginManager
    })
  const disabled = await owner.pluginManager.setBundleEnabled('dsh-native-pet', false)
  steps.push({ api: 'PluginManager.setBundleEnabled(dsh-native-pet, false)', result: disabled })
  assert.ok(!(await manifest()).dsh.profile.bundles.includes('dsh-native-pet'))
  assert.ok((await manifest()).dependencies['dsh-native-pet'], 'disable retains the installed dependency')
  const disabledConfig = await command(['--profile', 'web', '--dump-config'])
  assert.doesNotMatch(disabledConfig, /id: native-pet/)
  const enabled = await owner.pluginManager.setBundleEnabled('dsh-native-pet', true)
  steps.push({ api: 'PluginManager.setBundleEnabled(dsh-native-pet, true)', result: enabled })
  assert.ok((await manifest()).dsh.profile.bundles.includes('dsh-native-pet'))
  await owner.fiber.dispose()
  owner = undefined

  await command(['plugin', '--profile', 'web', 'remove', 'dsh-native-pet', '--config.ignore-scripts=true', '--store-dir', join(home, 'pnpm-store')])
  const removed = await manifest()
  assert.equal(removed.dependencies?.['dsh-native-pet'], undefined)
  assert.ok(!removed.dsh.profile.bundles.includes('dsh-native-pet'))
  const removedConfig = await command(['--profile', 'web', '--dump-config'])
  assert.doesNotMatch(removedConfig, /id: native-pet/)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ passed: true, isolatedHome: home, tarball, steps }, null, 2) + '\n')
  console.log(`Isolated Web-profile package smoke passed; evidence: ${output}`)
} catch (error) {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ passed: false, isolatedHome: home, tarball, error: String(error), stdout: error.stdout, stderr: error.stderr, steps }, null, 2) + '\n')
  console.error(`Package smoke evidence: ${output}`)
  throw error
} finally {
  await owner?.fiber.dispose()
  await rm(home, { recursive: true, force: true })
}
