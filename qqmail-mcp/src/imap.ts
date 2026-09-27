import { createWriteStream } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { dirname, resolve } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { ImapFlow } from 'imapflow'
import type {
  DownloadObject,
  FetchMessageObject,
  MessageStructureObject,
  SearchObject,
} from 'imapflow'
import { getQQMailConfig } from './config.js'
import type {
  AttachmentInfo,
  EmailDetail,
  EmailSummary,
  QueryEmailsResult,
} from './types.js'

const IMAP_HOST = 'imap.qq.com'
const IMAP_PORT = 993
const DEFAULT_FOLDER = 'INBOX'
const DEFAULT_QUERY_LIMIT = 20
const MAX_QUERY_LIMIT = 100

let client: ImapFlow | undefined

type SortOrder = 'desc' | 'asc'

function getClient(): ImapFlow {
  if (!client) {
    const { user, authCode } = getQQMailConfig()
    client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: {
        user,
        pass: authCode,
      },
      logger: false,
    })

    client.on('error', err => {
      // eslint-disable-next-line no-console
      console.error('[qqmail-mcp] IMAP error:', err.message)
    })
  }
  return client
}

async function ensureConnected(): Promise<ImapFlow> {
  const imap = getClient()
  if (!imap.usable) {
    await imap.connect()
  }
  return imap
}

function formatAddress(
  addresses?: { name?: string; address?: string }[],
): { name: string; address: string }[] {
  return (addresses ?? []).map(a => ({
    name: a.name ?? '',
    address: a.address ?? '',
  }))
}

function normalizeFolder(folder?: string): string {
  if (folder !== undefined && typeof folder !== 'string') {
    throw new Error('folder must be a string')
  }

  const normalized = folder?.trim()
  return normalized || DEFAULT_FOLDER
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_QUERY_LIMIT
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('limit must be a positive integer')
  }
  return Math.min(limit, MAX_QUERY_LIMIT)
}

function normalizeSortOrder(sortOrder: SortOrder | undefined): SortOrder {
  if (!sortOrder) return 'desc'
  if (sortOrder !== 'asc' && sortOrder !== 'desc') {
    throw new Error('sortOrder must be "asc" or "desc"')
  }
  return sortOrder
}

function parseDateInput(value: string | undefined, field: string): Date | undefined {
  if (!value) return undefined

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid ISO 8601 date`)
  }
  return date
}

function normalizeDate(value: Date | string | undefined): Date | undefined {
  if (!value) return undefined

  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date
}

function formatDate(date: Date | undefined): string {
  if (!date) return ''
  // Use system locale and timezone so the displayed time matches the user's
  // local time (same as QQ Mail web interface).
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function dateToIso(date: Date | undefined): string {
  return date ? date.toISOString() : ''
}

function dateToTimestamp(date: Date | undefined): number {
  return date ? date.getTime() : 0
}

function getMessageDates(
  msg: Pick<FetchMessageObject, 'internalDate' | 'envelope'>,
): { receivedAt?: Date; sentAt?: Date; primaryDate?: Date } {
  const receivedAt = normalizeDate(msg.internalDate)
  const sentAt = normalizeDate(msg.envelope?.date)
  const primaryDate = receivedAt ?? sentAt

  return { receivedAt, sentAt, primaryDate }
}

function toEmailSummary(
  msg: FetchMessageObject,
  hasAttachments = false,
): EmailSummary {
  const { receivedAt, sentAt, primaryDate } = getMessageDates(msg)

  return {
    uid: msg.uid,
    subject: msg.envelope?.subject ?? '',
    from: formatAddress(msg.envelope?.from),
    date: formatDate(primaryDate),
    dateIso: dateToIso(primaryDate),
    timestamp: dateToTimestamp(primaryDate),
    receivedAt: dateToIso(receivedAt),
    sentAt: dateToIso(sentAt),
    hasAttachments,
    isRead: msg.flags?.has('\\Seen') ?? true,
  }
}

function compareEmailSummaries(sortOrder: SortOrder) {
  return (a: EmailSummary, b: EmailSummary): number => {
    const aHasDate = a.timestamp > 0
    const bHasDate = b.timestamp > 0
    if (aHasDate !== bHasDate) return aHasDate ? -1 : 1

    if (a.timestamp !== b.timestamp) {
      return sortOrder === 'asc'
        ? a.timestamp - b.timestamp
        : b.timestamp - a.timestamp
    }

    return sortOrder === 'asc' ? a.uid - b.uid : b.uid - a.uid
  }
}

function validateUids(uids: number[] | undefined, field = 'uids'): number[] {
  if (!Array.isArray(uids) || uids.length === 0) {
    throw new Error(`${field} must contain at least one UID`)
  }

  for (const uid of uids) {
    if (!Number.isInteger(uid) || uid < 1) {
      throw new Error(`${field} must contain only positive integer UIDs`)
    }
  }

  return uids
}

function requireNonEmpty(value: string | undefined, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`)
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`${field} must not be empty`)
  }
  return normalized
}

function walkBodyStructure(
  node: MessageStructureObject,
  prefix = '',
): Array<MessageStructureObject & { part: string }> {
  const nodePart = node.part ?? prefix
  const result: Array<MessageStructureObject & { part: string }> = []

  if (node.type?.toLowerCase().startsWith('multipart/')) {
    for (let i = 0; i < (node.childNodes?.length ?? 0); i++) {
      const child = node.childNodes![i]
      const childPrefix = nodePart ? `${nodePart}.${i + 1}` : `${i + 1}`
      result.push(...walkBodyStructure(child, childPrefix))
    }
  } else {
    const part = nodePart || '1'
    result.push({ ...node, part })
  }

  return result
}

function isAttachment(node: MessageStructureObject): boolean {
  const disp = node.disposition?.toLowerCase()
  if (disp === 'attachment') return true
  if (disp === 'inline' && node.dispositionParameters?.filename) return true
  return false
}

function getFilename(node: MessageStructureObject): string {
  return (
    node.dispositionParameters?.filename ||
    node.parameters?.name ||
    'attachment'
  )
}

function normalizeFilename(filename: string): string {
  return filename.trim().toLowerCase()
}

function validateDownloadedAttachment(
  download: DownloadObject,
  node: MessageStructureObject & { part: string },
): void {
  const expectedType = node.type?.toLowerCase()
  const actualType = download.meta?.contentType?.toLowerCase()

  if (expectedType && actualType && expectedType !== actualType) {
    throw new Error(
      `Downloaded IMAP part ${node.part} has content type ${actualType}, expected ${expectedType}. Refusing to save a mismatched attachment.`,
    )
  }

  const expectedFilename = getFilename(node)
  const actualFilename = download.meta?.filename
  if (
    actualFilename &&
    normalizeFilename(actualFilename) !== normalizeFilename(expectedFilename)
  ) {
    throw new Error(
      `Downloaded IMAP part ${node.part} is "${actualFilename}", expected "${expectedFilename}". Refusing to save a mismatched attachment.`,
    )
  }
}

export async function listMailboxes(): Promise<string[]> {
  const imap = await ensureConnected()
  const list = await imap.list()
  return list.map(m => m.path)
}

export type QueryEmailsOptions = {
  folder?: string
  limit?: number
  since?: string
  unreadOnly?: boolean
  search?: string
  sortOrder?: SortOrder
}

export async function queryEmails(
  options: QueryEmailsOptions,
): Promise<QueryEmailsResult> {
  const imap = await ensureConnected()
  const folder = normalizeFolder(options.folder)
  const limit = normalizeLimit(options.limit)
  const sortOrder = normalizeSortOrder(options.sortOrder)
  const since = parseDateInput(options.since, 'since')
  const search = options.search?.trim()

  const lock = await imap.getMailboxLock(folder)
  try {
    const query: SearchObject = { all: true }
    if (options.unreadOnly) {
      query.seen = false
    }
    if (since) {
      query.since = since
    }
    if (search) {
      query.or = [
        { subject: search },
        { from: search },
        { text: search },
      ]
    }

    const uids = await imap.search(query, { uid: true })
    if (!uids || uids.length === 0) {
      return { emails: [], totalMatched: 0 }
    }

    const totalMatched = uids.length

    const messages: EmailSummary[] = []
    for await (const msg of imap.fetch(
      uids as number[],
      {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
      },
      { uid: true },
    )) {
      messages.push(toEmailSummary(msg))
    }

    const selectedMessages = messages
      .sort(compareEmailSummaries(sortOrder))
      .slice(0, limit)

    if (selectedMessages.length > 0) {
      const attachmentByUid = new Map<number, boolean>()
      for await (const msg of imap.fetch(
        selectedMessages.map(email => email.uid),
        {
          uid: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        attachmentByUid.set(
          msg.uid,
          msg.bodyStructure
            ? walkBodyStructure(msg.bodyStructure).some(isAttachment)
            : false,
        )
      }

      for (const message of selectedMessages) {
        message.hasAttachments = attachmentByUid.get(message.uid) ?? false
      }
    }

    return { emails: selectedMessages, totalMatched }
  } finally {
    lock.release()
  }
}

export type GetEmailOptions = {
  folder?: string
  uid: number
  includeBody?: boolean
  includeAttachments?: boolean
}

export async function getEmail(
  options: GetEmailOptions,
): Promise<EmailDetail> {
  const imap = await ensureConnected()
  const folder = normalizeFolder(options.folder)
  validateUids([options.uid], 'uid')
  const includeBody = options.includeBody ?? true
  const includeAttachments = options.includeAttachments ?? true

  const lock = await imap.getMailboxLock(folder)
  try {
    const msg = await imap.fetchOne(
      String(options.uid),
      {
        uid: true,
        envelope: true,
        internalDate: true,
        bodyStructure: true,
      },
      { uid: true },
    )

    if (!msg) {
      throw new Error(`Email not found: uid ${options.uid} in ${folder}`)
    }

    const nodes = msg.bodyStructure ? walkBodyStructure(msg.bodyStructure) : []

    const textPart = nodes.find(
      n => n.type?.toLowerCase() === 'text/plain' && !isAttachment(n),
    )
    const htmlPart = nodes.find(
      n => n.type?.toLowerCase() === 'text/html' && !isAttachment(n),
    )

    let textBody = ''
    let htmlBody = ''
    const attachments: AttachmentInfo[] = []

    if (includeBody && textPart) {
      const download = await imap.download(String(options.uid), textPart.part, {
        uid: true,
      })
      textBody = await streamToString(download.content)
    }

    if (includeBody && htmlPart) {
      const download = await imap.download(String(options.uid), htmlPart.part, {
        uid: true,
      })
      htmlBody = await streamToString(download.content)
    }

    if (includeAttachments) {
      for (const node of nodes.filter(isAttachment)) {
        attachments.push({
          filename: getFilename(node),
          size: node.size ?? 0,
          partId: node.part,
        })
      }
    }

    const { receivedAt, sentAt, primaryDate } = getMessageDates(msg)

    return {
      uid: msg.uid,
      subject: msg.envelope?.subject ?? '',
      from: formatAddress(msg.envelope?.from),
      to: formatAddress(msg.envelope?.to),
      date: formatDate(primaryDate),
      dateIso: dateToIso(primaryDate),
      timestamp: dateToTimestamp(primaryDate),
      receivedAt: dateToIso(receivedAt),
      sentAt: dateToIso(sentAt),
      textBody,
      htmlBody,
      attachments,
    }
  } finally {
    lock.release()
  }
}

async function streamToString(
  stream: Readable | Buffer | undefined,
): Promise<string> {
  if (!stream) return ''
  if (Buffer.isBuffer(stream)) return stream.toString('utf-8')

  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf-8')
}

export type MoveEmailsOptions = {
  folder?: string
  uids: number[]
  targetFolder: string
}

export async function moveEmails(
  options: MoveEmailsOptions,
): Promise<{ uid: number; success: boolean; error?: string }[]> {
  const imap = await ensureConnected()
  const folder = normalizeFolder(options.folder)
  const uids = validateUids(options.uids)
  const targetFolder = requireNonEmpty(options.targetFolder, 'targetFolder')

  const lock = await imap.getMailboxLock(folder)
  try {
    const result = await imap.messageMove(uids, targetFolder, {
      uid: true,
    })

    if (!result) {
      throw new Error('Move operation failed')
    }

    return uids.map(uid => ({ uid, success: true }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return uids.map(uid => ({ uid, success: false, error: message }))
  } finally {
    lock.release()
  }
}

export type ArchiveEmailsOptions = {
  folder?: string
  uids: number[]
}

export async function archiveEmails(
  options: ArchiveEmailsOptions,
): Promise<{ uid: number; success: boolean; error?: string }[]> {
  const imap = await ensureConnected()
  const uids = validateUids(options.uids)

  // Ensure Archive mailbox exists
  const mailboxes = await listMailboxes()
  const archiveName = 'Archive'
  if (!mailboxes.includes(archiveName)) {
    try {
      await imap.mailboxCreate(archiveName)
    } catch (err) {
      // May already exist or be named differently; continue and let move fail
    }
  }

  return moveEmails({
    folder: normalizeFolder(options.folder),
    uids,
    targetFolder: archiveName,
  })
}

export type DownloadAttachmentOptions = {
  folder?: string
  uid: number
  filename: string
  outputPath: string
  partId?: string
}

export async function downloadAttachment(
  options: DownloadAttachmentOptions,
): Promise<{ savedPath: string; bytesWritten: number }> {
  const imap = await ensureConnected()
  const folder = normalizeFolder(options.folder)
  validateUids([options.uid], 'uid')
  requireNonEmpty(options.filename, 'filename')

  const outputPath = resolve(requireNonEmpty(options.outputPath, 'outputPath'))
  let partId = options.partId?.trim() || undefined

  // Ensure target directory exists
  await mkdir(dirname(outputPath), { recursive: true })

  const lock = await imap.getMailboxLock(folder)
  let download: DownloadObject
  let node: MessageStructureObject & { part: string }
  try {
    const msg = await imap.fetchOne(
      String(options.uid),
      {
        bodyStructure: true,
      },
      { uid: true },
    )
    if (!msg) {
      throw new Error(`Email not found: uid ${options.uid} in ${folder}`)
    }

    const nodes = msg.bodyStructure ? walkBodyStructure(msg.bodyStructure) : []
    const filename = requireNonEmpty(options.filename, 'filename')

    if (partId) {
      const matchedNode = nodes.find(n => n.part === partId)
      if (!matchedNode) {
        throw new Error(
          `IMAP part "${partId}" not found in email ${options.uid}`,
        )
      }
      if (!isAttachment(matchedNode)) {
        throw new Error(
          `IMAP part "${partId}" is not an attachment in email ${options.uid}`,
        )
      }
      if (getFilename(matchedNode) !== filename) {
        throw new Error(
          `IMAP part "${partId}" is "${getFilename(matchedNode)}", expected "${filename}"`,
        )
      }
      node = matchedNode
    } else {
      const matchedNode = nodes.find(
        n => isAttachment(n) && getFilename(n) === filename,
      )
      if (!matchedNode) {
        throw new Error(
          `Attachment "${filename}" not found in email ${options.uid}`,
        )
      }
      node = matchedNode
      partId = node.part
    }

    download = await imap.download(String(options.uid), partId, {
      uid: true,
    })
    validateDownloadedAttachment(download, node)
  } finally {
    lock.release()
  }

  if (!download.content) {
    throw new Error('Attachment content is empty')
  }
  const writeStream = createWriteStream(outputPath)
  await pipeline(download.content, writeStream)

  const stats = await stat(outputPath)
  return { savedPath: outputPath, bytesWritten: stats.size }
}
