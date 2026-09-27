import { z } from 'zod/v4'
import {
  archiveEmails,
  downloadAttachment,
  getEmail,
  moveEmails,
  queryEmails,
} from './imap.js'
import { downloadCateringInvoices } from './invoices.js'

const toolDescriptions = {
  qqmail_query_emails:
    'Search and list emails from a QQ Mail folder. Returns summaries sorted by received time, including uid, subject, sender, date, and attachment status. Use this when the user wants to see, find, or summarize emails.',
  qqmail_get_email:
    'Get the full details of a single email by uid, including body text and attachment list. Use this when the user wants to read or summarize a specific email.',
  qqmail_move_emails:
    'Move one or more emails by uid to a target folder. Use this to organize emails into folders.',
  qqmail_archive_emails:
    'Archive one or more emails by moving them to the Archive folder. Creates the Archive folder if it does not exist.',
  qqmail_download_attachment:
    'Download an attachment from a specific email to a local file path.',
  qqmail_download_catering_invoices:
    'Download catering invoice PDFs from QQ Mail for a given year. Handles normal PDF attachments and Nuonuo/诺诺 HTML short links by resolving the Nuonuo invoice API directly, bypassing HTTP proxy variables by default, deduplicating by PDF hash, and naming files by invoice amount.',
} as const

export const qqmailTools = [
  {
    name: 'qqmail_query_emails',
    description: toolDescriptions.qqmail_query_emails,
    inputSchema: z.object({
      folder: z
        .string()
        .optional()
        .default('INBOX')
        .describe('IMAP folder to search, e.g., INBOX, Sent, Archive'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(20)
        .describe('Maximum number of emails to return'),
      since: z
        .string()
        .optional()
        .describe('ISO 8601 date. Only return emails received on or after this date.'),
      unreadOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe('If true, only return unread emails'),
      search: z
        .string()
        .optional()
        .describe('Keyword to search in subject, from, or body'),
      sortOrder: z
        .enum(['desc', 'asc'])
        .optional()
        .default('desc')
        .describe('Sort by received time: desc for newest first, asc for oldest first'),
    }),
    handler: async (input: {
      folder?: string
      limit?: number
      since?: string
      unreadOnly?: boolean
      search?: string
      sortOrder?: 'desc' | 'asc'
    }) => queryEmails(input),
  },
  {
    name: 'qqmail_get_email',
    description: toolDescriptions.qqmail_get_email,
    inputSchema: z.object({
      uid: z.number().int().positive().describe('UID of the email to retrieve'),
      folder: z.string().optional().default('INBOX').describe('Folder containing the email'),
      includeBody: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to include the email body'),
      includeAttachments: z
        .boolean()
        .optional()
        .default(true)
        .describe('Whether to include the attachment list'),
    }),
    handler: async (input: {
      uid: number
      folder?: string
      includeBody?: boolean
      includeAttachments?: boolean
    }) => getEmail(input),
  },
  {
    name: 'qqmail_move_emails',
    description: toolDescriptions.qqmail_move_emails,
    inputSchema: z.object({
      uids: z.array(z.number().int().positive()).min(1).describe('UIDs of emails to move'),
      targetFolder: z.string().min(1).describe('Destination folder path'),
      folder: z
        .string()
        .optional()
        .default('INBOX')
        .describe('Source folder path'),
    }),
    handler: async (input: {
      uids: number[]
      targetFolder: string
      folder?: string
    }) => moveEmails(input),
  },
  {
    name: 'qqmail_archive_emails',
    description: toolDescriptions.qqmail_archive_emails,
    inputSchema: z.object({
      uids: z.array(z.number().int().positive()).min(1).describe('UIDs of emails to archive'),
      folder: z.string().optional().default('INBOX').describe('Source folder path'),
    }),
    handler: async (input: { uids: number[]; folder?: string }) =>
      archiveEmails(input),
  },
  {
    name: 'qqmail_download_attachment',
    description: toolDescriptions.qqmail_download_attachment,
    inputSchema: z.object({
      uid: z.number().int().positive().describe('UID of the email containing the attachment'),
      filename: z.string().min(1).describe('Name of the attachment file'),
      outputPath: z
        .string()
        .min(1)
        .describe('Local file path where the attachment should be saved'),
      folder: z.string().optional().default('INBOX').describe('Folder containing the email'),
      partId: z
        .string()
        .optional()
        .describe('Optional IMAP body part id. If omitted, looked up by filename.'),
    }),
    handler: async (input: {
      uid: number
      filename: string
      outputPath: string
      folder?: string
      partId?: string
    }) => downloadAttachment(input),
  },
  {
    name: 'qqmail_download_catering_invoices',
    description: toolDescriptions.qqmail_download_catering_invoices,
    inputSchema: z.object({
      year: z
        .number()
        .int()
        .min(2000)
        .max(2100)
        .optional()
        .describe('Invoice year to scan. Defaults to the current year.'),
      since: z
        .string()
        .optional()
        .describe(
          'Optional ISO 8601 lower-bound date. Defaults to January 1 of the selected year in China time.',
        ),
      outputDir: z
        .string()
        .optional()
        .describe(
          'Local output directory. Defaults to downloads/qqmail-catering-invoices-<year>.',
        ),
      directNuonuoRequests: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'If true, temporarily clears HTTP_PROXY/HTTPS_PROXY for Nuonuo invoice HTTP requests.',
        ),
    }),
    handler: async (input: {
      year?: number
      since?: string
      outputDir?: string
      directNuonuoRequests?: boolean
    }) => downloadCateringInvoices(input),
  },
]

export type QQMailTool = (typeof qqmailTools)[number]
