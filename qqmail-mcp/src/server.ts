#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { getQQMailConfig } from './config.js'
import { qqmailTools } from './tools.js'

async function main(): Promise<void> {
  // Validate config early so the server fails fast with a clear error
  getQQMailConfig()

  const server = new McpServer(
    {
      name: 'qqmail-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {},
    },
  )

  for (const tool of qqmailTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: unknown, _extra: unknown) => {
        try {
          const result = await tool.handler(args as never)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: message }, null, 2),
              },
            ],
            isError: true,
          }
        }
      },
    )
  }

  const transport = new StdioServerTransport()

  let exiting = false
  const shutdown = async (): Promise<void> => {
    if (exiting) return
    exiting = true
    try {
      await server.close()
    } catch {
      // ignore
    }
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }

  process.stdin.on('end', () => void shutdown())
  process.stdin.on('error', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  await server.connect(transport)
}

void main().catch(err => {
  // eslint-disable-next-line no-console
  console.error('[qqmail-mcp] Failed to start:', err)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
})
