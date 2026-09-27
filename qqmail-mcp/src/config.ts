import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { QQMailConfig } from './types.js'

type JsonObject = Record<string, unknown>

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function getConfigFromClaudeJson(): Partial<QQMailConfig> {
  const configPath = join(homedir(), '.claude.json')
  if (!existsSync(configPath)) return {}

  try {
    const root = asObject(JSON.parse(readFileSync(configPath, 'utf8')))
    const mcpServers = asObject(root?.mcpServers)
    const qqmail = asObject(mcpServers?.qqmail)
    const env = asObject(qqmail?.env)

    return {
      user: asString(env?.QQMAIL_USER),
      authCode: asString(env?.QQMAIL_AUTH_CODE),
    }
  } catch {
    return {}
  }
}

export function getQQMailConfig(): QQMailConfig {
  const fileConfig = getConfigFromClaudeJson()
  const user = asString(process.env.QQMAIL_USER) ?? fileConfig.user
  const authCode = asString(process.env.QQMAIL_AUTH_CODE) ?? fileConfig.authCode

  if (!user || !authCode) {
    throw new Error(
      'Missing QQ Mail credentials. Set QQMAIL_USER and QQMAIL_AUTH_CODE environment variables, or configure mcpServers.qqmail.env in ~/.claude.json.',
    )
  }

  if (!user.includes('@')) {
    throw new Error(
      'QQMAIL_USER must be a full email address (e.g., 123456789@qq.com).',
    )
  }

  return { user, authCode }
}
