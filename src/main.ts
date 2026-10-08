import {
  getBooleanInput,
  getInput,
  group,
  info,
  setFailed,
  setOutput
} from '@actions/core'
import {exec} from '@actions/exec'
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, extname, join} from 'node:path'
import {
  KINDS,
  assess,
  maskKey,
  parseAttempts,
  staple,
  submit,
  waitFor
} from './notarize'

async function run(): Promise<void> {
  try {
    await main()
  } catch (err) {
    setFailed(err instanceof Error ? err.message : String(err))
  }
}

async function main(): Promise<void> {
  const path = getInput('path', {required: true})
  const issuerId = getInput('issuer-id', {required: true})
  const keyId = getInput('api-key-id', {required: true})
  const key = maskKey(getInput('api-private-key', {required: true}))
  const doStaple = getBooleanInput('staple')
  const attempts = parseAttempts(getInput('attempts') || '3')
  const timeout = getInput('timeout') || '1h'

  const kind = extname(path).toLowerCase()
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw new Error(`\`path\` must end in ${KINDS.join(', ')}: ${path}`)
  }
  if (!existsSync(path)) throw new Error(`Not found: ${path}`)

  const dir = mkdtempSync(join(tmpdir(), 'notarize-'))
  try {
    const keyPath = join(dir, `AuthKey_${keyId}.p8`)
    writeFileSync(keyPath, key, {mode: 0o600})
    const auth = ['--key', keyPath, '--key-id', keyId, '--issuer', issuerId]

    let submitPath = path
    if (kind === '.app') {
      submitPath = join(dir, `${basename(path, '.app')}.zip`)
      await exec('ditto', ['-c', '-k', '--keepParent', path, submitPath])
    }

    const id = await submit(submitPath, auth, attempts)
    setOutput('submission-id', id)
    info(`Submitted for notarization (${id})`)

    const result = await waitFor(id, auth, attempts, timeout)
    setOutput('status', result.status ?? '')

    if (result.status !== 'Accepted') {
      await group('notarytool log', async () => {
        await exec('xcrun', ['notarytool', 'log', id, ...auth], {
          ignoreReturnCode: true
        })
      })
      throw new Error(
        `Notarization ${result.status}: ${result.message ?? 'see notarytool log above'}`
      )
    }
    info(`Notarization accepted (${id})`)

    if (doStaple && kind !== '.zip') {
      await staple(path, attempts)
      await assess(path, kind)
    }
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

run()
