import {
  getBooleanInput,
  getInput,
  group,
  info,
  setFailed,
  setOutput,
  setSecret,
  warning
} from '@actions/core'
import {exec, getExecOutput} from '@actions/exec'
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {basename, extname, join} from 'node:path'

interface Submission {
  id?: string
  status?: string
  message?: string
}

const KINDS = ['.dmg', '.pkg', '.zip', '.app'] as const
const FINAL = new Set(['Accepted', 'Invalid', 'Rejected'])

const sleep = async (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

async function notarytool(
  args: string[]
): Promise<{json?: Submission; text: string}> {
  const out = await getExecOutput(
    'xcrun',
    ['notarytool', ...args, '--output-format', 'json'],
    {ignoreReturnCode: true}
  )
  try {
    return {json: JSON.parse(out.stdout) as Submission, text: out.stdout}
  } catch {
    return {text: `${out.stdout}\n${out.stderr}`.trim()}
  }
}

async function notarize(
  file: string,
  auth: string[],
  attempts: number,
  timeout: string
): Promise<Submission> {
  let result: Submission = {}
  for (let attempt = 1; ; attempt++) {
    // A dropped connection during --wait leaves a live submission; resume it
    // instead of submitting a duplicate.
    const res = result.id
      ? await notarytool(['wait', result.id, ...auth, '--timeout', timeout])
      : await notarytool([
          'submit',
          file,
          ...auth,
          '--wait',
          '--timeout',
          timeout
        ])
    result = {...result, ...res.json}
    if (result.status && FINAL.has(result.status)) return result
    if (attempt >= attempts) {
      throw new Error(
        `notarytool did not reach a final status after ${attempts} attempts: ${res.text}`
      )
    }
    warning(`notarytool attempt ${attempt} did not finish; retrying`)
    await sleep(30_000 * attempt)
  }
}

async function staple(path: string, attempts: number): Promise<void> {
  // The ticket can take a short while to publish after acceptance.
  for (let attempt = 1; ; attempt++) {
    const code = await exec('xcrun', ['stapler', 'staple', path], {
      ignoreReturnCode: true
    })
    if (code === 0) break
    if (attempt >= attempts) {
      throw new Error(`stapler failed after ${attempts} attempts`)
    }
    warning(`stapler attempt ${attempt} failed; retrying`)
    await sleep(20_000 * attempt)
  }
  await exec('xcrun', ['stapler', 'validate', path])
}

async function assess(path: string, kind: string): Promise<void> {
  const args =
    kind === '.dmg'
      ? ['-a', '-t', 'open', '--context', 'context:primary-signature', '-vv']
      : kind === '.pkg'
        ? ['-a', '-t', 'install', '-vv']
        : ['-a', '-t', 'exec', '-vv']
  const out = await getExecOutput('spctl', [...args, path], {
    ignoreReturnCode: true
  })
  const text = `${out.stdout}\n${out.stderr}`
  if (out.exitCode !== 0 || !text.includes('source=Notarized Developer ID')) {
    throw new Error(`Gatekeeper rejected ${path}: ${text.trim()}`)
  }
}

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
  const rawKey = getInput('api-private-key', {required: true})
  const doStaple = getBooleanInput('staple')
  const attempts = Math.max(1, Number.parseInt(getInput('attempts') || '3', 10))
  const timeout = getInput('timeout') || '1h'
  setSecret(rawKey)

  const kind = extname(path).toLowerCase()
  if (!(KINDS as readonly string[]).includes(kind)) {
    throw new Error(`\`path\` must end in ${KINDS.join(', ')}: ${path}`)
  }
  if (!existsSync(path)) throw new Error(`Not found: ${path}`)

  const dir = mkdtempSync(join(tmpdir(), 'notarize-'))
  try {
    const keyPath = join(dir, `AuthKey_${keyId}.p8`)
    writeFileSync(keyPath, rawKey.replace(/\\n/g, '\n'), {mode: 0o600})
    const auth = ['--key', keyPath, '--key-id', keyId, '--issuer', issuerId]

    let submitPath = path
    if (kind === '.app') {
      submitPath = join(dir, `${basename(path, '.app')}.zip`)
      await exec('ditto', ['-c', '-k', '--keepParent', path, submitPath])
    }

    const result = await notarize(submitPath, auth, attempts, timeout)
    if (result.id) setOutput('submission-id', result.id)
    setOutput('status', result.status ?? '')

    if (result.status !== 'Accepted') {
      const id = result.id
      if (id) {
        await group('notarytool log', async () => {
          await exec('xcrun', ['notarytool', 'log', id, ...auth], {
            ignoreReturnCode: true
          })
        })
      }
      throw new Error(
        `Notarization ${result.status}: ${result.message ?? 'see notarytool log above'}`
      )
    }
    info(`Notarization accepted (${result.id})`)

    if (doStaple && kind !== '.zip') {
      await staple(path, attempts)
      await assess(path, kind)
    }
  } finally {
    rmSync(dir, {recursive: true, force: true})
  }
}

run()
