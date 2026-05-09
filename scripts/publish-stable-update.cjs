#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const cur = String(argv[i] || '')
    if (!cur.startsWith('--')) continue
    const key = cur.slice(2)
    const next = argv[i + 1]
    if (!next || String(next).startsWith('--')) out[key] = true
    else {
      out[key] = String(next)
      i += 1
    }
  }
  return out
}

function required(value, name) {
  const v = String(value || '').trim()
  if (!v) throw new Error(`Missing required ${name}`)
  return v
}

function readLatestYml(latestPath) {
  const raw = fs.readFileSync(latestPath, 'utf8')
  const pathMatch = raw.match(/^path:\s*(.+)$/m)
  if (!pathMatch) throw new Error('latest.yml does not contain "path"')
  const installerName = String(pathMatch[1] || '').trim().replace(/^['"]|['"]$/g, '')
  if (!installerName) throw new Error('Invalid installer path in latest.yml')
  return { raw, installerName }
}

function normalizeNameVariants(name) {
  const raw = String(name || '').trim()
  const out = new Set()
  if (!raw) return []
  out.add(raw)
  try {
    out.add(decodeURIComponent(raw))
  } catch (_) {}
  out.add(raw.replace(/%20/gi, ' '))
  out.add(raw.replace(/-/g, ' '))
  out.add(raw.replace(/\s+/g, '-'))
  out.add(raw.replace(/\s+/g, ' '))
  return Array.from(out).filter(Boolean)
}

function resolveInstallerArtifact(distDir, installerName) {
  const variants = normalizeNameVariants(installerName)
  for (const v of variants) {
    const p = path.resolve(distDir, v)
    if (fs.existsSync(p)) return p
  }
  const versionMatch = String(installerName || '').match(/(\d+\.\d+\.\d+)/)
  const version = versionMatch ? versionMatch[1] : ''
  const files = fs.readdirSync(distDir).filter((f) => /\.exe$/i.test(f))
  const preferred = files.find((f) => {
    const n = String(f).toLowerCase()
    return n.includes('setup') && (!version || n.includes(version))
  })
  if (preferred) return path.resolve(distDir, preferred)
  if (files.length === 1) return path.resolve(distDir, files[0])
  return null
}

function run(bin, args, options = {}) {
  return execFileSync(bin, args, {
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  })
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const root = path.resolve(__dirname, '..')
  const distDir = path.resolve(root, 'dist')
  const latestPath = path.resolve(distDir, 'latest.yml')
  if (!fs.existsSync(latestPath)) {
    throw new Error(`Missing ${latestPath}. Build first: npm run build:win`)
  }

  const { installerName } = readLatestYml(latestPath)
  const expectedInstallerPath = path.resolve(distDir, installerName)
  const resolvedInstallerPath = resolveInstallerArtifact(distDir, installerName)
  if (!resolvedInstallerPath) {
    throw new Error(`Installer from latest.yml not found: ${expectedInstallerPath}`)
  }
  let installerPath = expectedInstallerPath
  if (path.resolve(resolvedInstallerPath) !== path.resolve(expectedInstallerPath)) {
    fs.copyFileSync(resolvedInstallerPath, expectedInstallerPath)
    const resolvedBlockmap = `${resolvedInstallerPath}.blockmap`
    const expectedBlockmap = `${expectedInstallerPath}.blockmap`
    if (fs.existsSync(resolvedBlockmap) && !fs.existsSync(expectedBlockmap)) {
      fs.copyFileSync(resolvedBlockmap, expectedBlockmap)
    }
  }
  const blockmapPath = `${installerPath}.blockmap`

  const host = required(args.host || process.env.FLOW_UPDATE_HOST, 'FLOW_UPDATE_HOST/--host')
  const user = required(args.user || process.env.FLOW_UPDATE_USER, 'FLOW_UPDATE_USER/--user')
  const port = String(args.port || process.env.FLOW_UPDATE_PORT || '22').trim()
  const remoteDir = required(
    args.dir || process.env.FLOW_UPDATE_DIR,
    'FLOW_UPDATE_DIR/--dir'
  )

  const target = `${user}@${host}`
  const remote = `${target}:${remoteDir.replace(/\\/g, '/')}/`
  const sshArgs = ['-p', port, '-o', 'StrictHostKeyChecking=accept-new', target, `mkdir -p "${remoteDir}"`]

  console.log('[flow-update] Ensuring remote directory...')
  run('ssh', sshArgs)

  const files = [latestPath, installerPath]
  if (fs.existsSync(blockmapPath)) files.push(blockmapPath)
  const scpArgs = ['-P', port, '-o', 'StrictHostKeyChecking=accept-new', ...files, remote]

  console.log('[flow-update] Uploading artifacts...')
  run('scp', scpArgs)

  console.log('[flow-update] Done.')
  console.log(`[flow-update] Published: ${installerName}`)
  console.log(`[flow-update] Feed: ${host}:${remoteDir.replace(/\\/g, '/')}`)
}

try {
  main()
} catch (err) {
  console.error('[flow-update] Failed:', err?.message || err)
  process.exit(1)
}
