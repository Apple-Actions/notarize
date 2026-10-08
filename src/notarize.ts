import {setSecret, warning} from '@actions/core'
import {exec, getExecOutput} from '@actions/exec'

interface Submission {
  id?: string
  status?: string
  message?: string
}

export const KINDS = ['.dmg', '.pkg', '.zip', '.app'] as const
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

export function parseAttempts(value: string): number {
  if (!/^[1-9]\d*$/.test(value.trim())) {
    throw new Error(`\`attempts\` must be a positive integer: ${value}`)
  }
  return Number(value.trim())
}

export function maskKey(rawKey: string): string {
  setSecret(rawKey)
  const key = rawKey.replace(/\\n/g, '\n')
  // The runner can't mask a multi-line value as a whole, so mask each line.
  for (const line of key.split('\n')) {
    if (line.trim()) setSecret(line.trim())
  }
  return key
}

// Submitting without --wait returns the ID within seconds, so a dropped
// connection while waiting can never lead to a duplicate submission.
export async function submit(
  file: string,
  auth: string[],
  attempts: number
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await notarytool(['submit', file, ...auth])
    if (res.json?.id) return res.json.id
    if (attempt >= attempts) {
      throw new Error(
        `notarytool submit failed after ${attempts} attempts: ${res.text}`
      )
    }
    warning(`notarytool submit attempt ${attempt} failed; retrying`)
    await sleep(30_000 * attempt)
  }
}

export async function waitFor(
  id: string,
  auth: string[],
  attempts: number,
  timeout: string
): Promise<Submission> {
  for (let attempt = 1; ; attempt++) {
    const res = await notarytool(['wait', id, ...auth, '--timeout', timeout])
    if (res.json?.status && FINAL.has(res.json.status)) {
      return {...res.json, id}
    }
    if (attempt >= attempts) {
      throw new Error(
        `notarytool wait ${id} did not reach a final status after ${attempts} attempts: ${res.text}`
      )
    }
    warning(`notarytool wait attempt ${attempt} did not finish; retrying`)
    await sleep(30_000 * attempt)
  }
}

export async function staple(path: string, attempts: number): Promise<void> {
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

export async function assess(path: string, kind: string): Promise<void> {
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
