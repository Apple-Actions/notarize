import {beforeEach, describe, expect, it, vi} from 'vitest'
import {exec, getExecOutput} from '@actions/exec'
import {setSecret, warning} from '@actions/core'
import {
  assess,
  maskKey,
  parseAttempts,
  staple,
  submit,
  waitFor
} from '../src/notarize'

vi.mock('@actions/exec', () => ({exec: vi.fn(), getExecOutput: vi.fn()}))
vi.mock('@actions/core', () => ({setSecret: vi.fn(), warning: vi.fn()}))

const execMock = vi.mocked(exec)
const execOutput = vi.mocked(getExecOutput)
const warningMock = vi.mocked(warning)
const auth = ['--key', 'k.p8', '--key-id', 'KEY', '--issuer', 'ISSUER']

function respond(...outputs: string[]): void {
  for (const stdout of outputs) {
    execOutput.mockResolvedValueOnce({exitCode: 0, stdout, stderr: ''})
  }
}

function subcommands(): string[] {
  return execOutput.mock.calls.map(call => (call[1] ?? [])[1])
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync()
  return promise
}

beforeEach(() => {
  execMock.mockReset()
  execOutput.mockReset()
  warningMock.mockReset()
  vi.useFakeTimers()
})

describe('submit', () => {
  it('returns the id without waiting', async () => {
    respond('{"id":"abc","message":"Successfully uploaded file"}')
    expect(await submit('a.dmg', auth, 3)).toBe('abc')
    const args = execOutput.mock.calls[0][1] ?? []
    expect(args).not.toContain('--wait')
    expect(args).toContain('--output-format')
  })

  it('retries when no JSON comes back', async () => {
    respond('network error', '{"id":"abc"}')
    expect(await settle(submit('a.dmg', auth, 3))).toBe('abc')
    expect(subcommands()).toEqual(['submit', 'submit'])
  })

  it('fails after its attempts are used up', async () => {
    respond('nope', 'nope')
    const result = expect(submit('a.dmg', auth, 2)).rejects.toThrow(
      'notarytool submit failed after 2 attempts'
    )
    await vi.runAllTimersAsync()
    await result
  })
})

describe('waitFor', () => {
  it('retries wait for the same id instead of resubmitting', async () => {
    respond(
      '{"id":"abc","status":"In Progress"}',
      'connection dropped',
      '{"id":"abc","status":"Accepted","message":"Processing complete"}'
    )
    const result = await settle(waitFor('abc', auth, 3, '1h'))
    expect(result).toEqual({
      id: 'abc',
      status: 'Accepted',
      message: 'Processing complete'
    })
    expect(subcommands()).toEqual(['wait', 'wait', 'wait'])
    for (const call of execOutput.mock.calls) {
      expect(call[1]?.[2]).toBe('abc')
    }
  })

  it('returns Invalid immediately without retrying', async () => {
    respond('{"id":"abc","status":"Invalid","message":"Processing complete"}')
    const result = await waitFor('abc', auth, 3, '1h')
    expect(result.status).toBe('Invalid')
    expect(execOutput).toHaveBeenCalledTimes(1)
  })

  it('has its own attempts, separate from submit', async () => {
    respond('nope', '{"id":"abc"}')
    const id = await settle(submit('a.dmg', auth, 2))
    respond(
      '{"status":"In Progress"}',
      '{"status":"Accepted","message":"Processing complete"}'
    )
    const result = await settle(waitFor(id, auth, 2, '1h'))
    expect(result.status).toBe('Accepted')
    expect(subcommands()).toEqual(['submit', 'submit', 'wait', 'wait'])
  })

  it('fails when the status never becomes final', async () => {
    respond('{"status":"In Progress"}', '{"status":"In Progress"}')
    const result = expect(waitFor('abc', auth, 2, '1h')).rejects.toThrow(
      'notarytool wait abc did not reach a final status after 2 attempts'
    )
    await vi.runAllTimersAsync()
    await result
  })
})

describe('staple', () => {
  it('staples and validates on the first try', async () => {
    execMock.mockResolvedValueOnce(0).mockResolvedValueOnce(0)
    await staple('a.dmg', 3)
    expect(execMock).toHaveBeenCalledTimes(2)
    expect(execMock.mock.calls[0]).toEqual([
      'xcrun',
      ['stapler', 'staple', 'a.dmg'],
      {ignoreReturnCode: true}
    ])
    expect(execMock.mock.calls[1]).toEqual([
      'xcrun',
      ['stapler', 'validate', 'a.dmg']
    ])
  })

  it('retries after a failed staple then validates', async () => {
    execMock
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
    await settle(staple('a.dmg', 3))
    expect(warningMock).toHaveBeenCalledWith(
      'stapler attempt 1 failed; retrying'
    )
    expect(execMock).toHaveBeenCalledTimes(3)
    expect(execMock.mock.calls[0][1]).toEqual(['stapler', 'staple', 'a.dmg'])
    expect(execMock.mock.calls[1][1]).toEqual(['stapler', 'staple', 'a.dmg'])
    expect(execMock.mock.calls[2][1]).toEqual(['stapler', 'validate', 'a.dmg'])
  })

  it('fails after its attempts are used up without validating', async () => {
    execMock.mockResolvedValue(1)
    const result = expect(staple('a.dmg', 2)).rejects.toThrow(
      'stapler failed after 2 attempts'
    )
    await vi.runAllTimersAsync()
    await result
    expect(execMock).toHaveBeenCalledTimes(2)
    for (const call of execMock.mock.calls) {
      expect(call[1]).toEqual(['stapler', 'staple', 'a.dmg'])
    }
  })
})

describe('assess', () => {
  it('uses open assessment for .dmg', async () => {
    execOutput.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'source=Notarized Developer ID',
      stderr: ''
    })
    await assess('a.dmg', '.dmg')
    expect(execOutput).toHaveBeenCalledWith(
      'spctl',
      [
        '-a',
        '-t',
        'open',
        '--context',
        'context:primary-signature',
        '-vv',
        'a.dmg'
      ],
      {ignoreReturnCode: true}
    )
  })

  it('uses install assessment for .pkg', async () => {
    execOutput.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'source=Notarized Developer ID',
      stderr: ''
    })
    await assess('a.pkg', '.pkg')
    expect(execOutput).toHaveBeenCalledWith(
      'spctl',
      ['-a', '-t', 'install', '-vv', 'a.pkg'],
      {ignoreReturnCode: true}
    )
  })

  it('uses exec assessment for .app', async () => {
    execOutput.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'source=Notarized Developer ID',
      stderr: ''
    })
    await assess('a.app', '.app')
    expect(execOutput).toHaveBeenCalledWith(
      'spctl',
      ['-a', '-t', 'exec', '-vv', 'a.app'],
      {ignoreReturnCode: true}
    )
  })

  it('accepts notarized Developer ID output', async () => {
    execOutput.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: 'source=Notarized Developer ID'
    })
    await expect(assess('a.app', '.app')).resolves.toBeUndefined()
  })

  it('rejects a non-zero exit code', async () => {
    execOutput.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'rejected'
    })
    await expect(assess('a.app', '.app')).rejects.toThrow(
      'Gatekeeper rejected a.app: rejected'
    )
  })

  it('rejects when the notarized source is missing', async () => {
    execOutput.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'source=Developer ID',
      stderr: ''
    })
    await expect(assess('a.app', '.app')).rejects.toThrow(
      'Gatekeeper rejected a.app: source=Developer ID'
    )
  })
})

describe('parseAttempts', () => {
  it('accepts positive integers', () => {
    expect(parseAttempts('3')).toBe(3)
    expect(parseAttempts(' 10 ')).toBe(10)
  })

  it.each(['0', '-1', 'abc', '1.5', '', '2x'])('rejects %j', value => {
    expect(() => parseAttempts(value)).toThrow(
      '`attempts` must be a positive integer'
    )
  })
})

describe('maskKey', () => {
  it('normalizes literal \\n and masks each line', () => {
    const key = maskKey(
      '-----BEGIN PRIVATE KEY-----\\nabc\\ndef\\n-----END PRIVATE KEY-----'
    )
    expect(key).toBe(
      '-----BEGIN PRIVATE KEY-----\nabc\ndef\n-----END PRIVATE KEY-----'
    )
    const masked = vi.mocked(setSecret).mock.calls.map(call => call[0])
    expect(masked).toEqual(expect.arrayContaining(['abc', 'def']))
  })
})
