import { createReadStream, createWriteStream } from 'fs'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { dirname, join, resolve } from 'path'
import { pipeline } from 'stream/promises'
import { ImapFlow } from 'imapflow'
import type { MessageStructureObject } from 'imapflow'
import { getQQMailConfig } from './config.js'

const IMAP_HOST = 'imap.qq.com'
const IMAP_PORT = 993
const LINK_FETCH_TIMEOUT_MS = 25_000
const MAX_LINKS_PER_HTML = 20

type AttachmentNode = MessageStructureObject & { part: string }

type Candidate = {
  uid: number
  partId: string
  filename: string
  size: number
  from: string
  subject: string
  isNuonuoSource: boolean
}

type HtmlCandidate = {
  uid: number
  partId: string
}

type FetchedInvoicePdf = {
  pdf: Buffer
  amountHint?: string
  cateringHint?: boolean
  nuonuoApi?: boolean
}

export type DownloadCateringInvoicesOptions = {
  year?: number
  since?: string
  outputDir?: string
  directNuonuoRequests?: boolean
}

export type DownloadCateringInvoicesResult = {
  year: number
  since: string
  outputDir: string
  foldersScanned: number
  messagesScanned: number
  pdfAttachmentsScanned: number
  downloaded: number
  downloadedByCateringText: number
  downloadedByNuonuoSource: number
  downloadedByNuonuoLink: number
  duplicateSkipped: number
  noAmountSkipped: number
  nonCateringSkipped: number
  failedDownloads: number
  htmlMessagesScanned: number
  htmlLinksScanned: number
  pdfLinksFound: number
  existingFilesIndexed: number
  nuonuoApiHits: number
  filesInOutputDir: number
  files: string[]
}

type ProxyEnvSnapshot = Record<string, string | undefined>

function snapshotProxyEnv(): ProxyEnvSnapshot {
  return {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    http_proxy: process.env.http_proxy,
    https_proxy: process.env.https_proxy,
    all_proxy: process.env.all_proxy,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  }
}

function restoreProxyEnv(snapshot: ProxyEnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function forceDirectHttpRequests(): void {
  delete process.env.HTTP_PROXY
  delete process.env.HTTPS_PROXY
  delete process.env.ALL_PROXY
  delete process.env.http_proxy
  delete process.env.https_proxy
  delete process.env.all_proxy
  process.env.NO_PROXY = '*'
  process.env.no_proxy = '*'
}

function normalizeYear(year: number | undefined): number {
  const normalized = year ?? new Date().getFullYear()
  if (!Number.isInteger(normalized) || normalized < 2000 || normalized > 2100) {
    throw new Error('year must be an integer between 2000 and 2100')
  }
  return normalized
}

function normalizeSince(value: string | undefined, year: number): Date {
  const since = value ? new Date(value) : new Date(`${year}-01-01T00:00:00+08:00`)
  if (Number.isNaN(since.getTime())) {
    throw new Error('since must be a valid ISO 8601 date')
  }
  return since
}

function walkBodyStructure(
  node: MessageStructureObject,
  prefix = '',
): AttachmentNode[] {
  const nodePart = node.part ?? prefix
  const result: AttachmentNode[] = []

  if (node.type?.toLowerCase().startsWith('multipart/')) {
    for (let i = 0; i < (node.childNodes?.length ?? 0); i++) {
      const child = node.childNodes![i]
      const childPrefix = nodePart ? `${nodePart}.${i + 1}` : `${i + 1}`
      result.push(...walkBodyStructure(child, childPrefix))
    }
  } else {
    result.push({ ...node, part: nodePart || '1' })
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

function isPdfAttachment(node: AttachmentNode): boolean {
  const filename = getFilename(node).toLowerCase()
  return filename.endsWith('.pdf') || node.type?.toLowerCase() === 'application/pdf'
}

function isHtmlBody(node: AttachmentNode): boolean {
  return node.type?.toLowerCase() === 'text/html' && !isAttachment(node)
}

function shouldScanMailbox(path: string, specialUse?: string): boolean {
  const special = specialUse?.toLowerCase()
  if (special && ['\\sent', '\\drafts', '\\trash', '\\junk'].includes(special)) {
    return false
  }

  return !/(已发送|草稿|垃圾|已删除|trash|sent|draft|junk|spam)/i.test(path)
}

function extractPdfText(filePath: string): string {
  try {
    return execFileSync('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function isCateringInvoice(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  return /发票/.test(compact) && /(餐饮|餐费|餐饮服务|餐饮费)/.test(compact)
}

function isNuonuoSource(from: string, subject: string): boolean {
  return /(诺诺|nuonuo|nuo\s*nuo|jss\.com|nuonuo\.com)/i.test(
    `${from} ${subject}`,
  )
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function extractUrls(html: string): string[] {
  const decoded = decodeHtmlEntities(html)
  const urls = new Set<string>()

  for (const match of decoded.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    if (match[1]?.startsWith('http')) urls.add(match[1])
  }
  for (const match of decoded.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
    urls.add(match[0])
  }

  return [...urls]
}

function isLikelyInvoiceUrl(url: string): boolean {
  return (
    isDirectNuonuoInvoiceUrl(url) ||
    /linktrace\.triggerdelivery\.com\/u\/o1/i.test(url)
  )
}

function isDirectNuonuoInvoiceUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'nnfp.jss.com.cn') return false
    if (parsed.pathname.startsWith('/allow/')) return false
    if (/\.(png|jpe?g|gif|webp|svg|css|js)$/i.test(parsed.pathname)) {
      return false
    }
    return true
  } catch {
    return false
  }
}

function candidateInvoiceUrls(html: string): string[] {
  const urls = extractUrls(html)
  const directNuonuoUrls = urls.filter(isDirectNuonuoInvoiceUrl)
  if (directNuonuoUrls.length > 0) {
    return directNuonuoUrls.slice(0, MAX_LINKS_PER_HTML)
  }

  return urls.filter(isLikelyInvoiceUrl).slice(0, MAX_LINKS_PER_HTML)
}

function directFetchHeaders(referer?: string): HeadersInit {
  return {
    'user-agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf,*/*;q=0.8',
    ...(referer ? { referer } : {}),
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
): Promise<Response | undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LINK_FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    })
  } catch {
    return undefined
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchNuonuoPdfFromShortUrl(
  url: string,
): Promise<FetchedInvoicePdf | undefined> {
  const entryResponse = await fetchWithTimeout(url, {
    redirect: 'follow',
    headers: directFetchHeaders(),
  })
  if (!entryResponse?.ok) return undefined

  const entryBuffer = Buffer.from(await entryResponse.arrayBuffer())
  if (entryBuffer.subarray(0, 5).toString('utf8') === '%PDF-') {
    return { pdf: entryBuffer }
  }

  const finalUrl = new URL(entryResponse.url)
  const paramList = finalUrl.searchParams.get('paramList')
  if (!paramList) return undefined

  const invoiceDetailMiddleUri = `${finalUrl.pathname.replace(
    /^\/scan-invoice\//,
    '',
  )}${finalUrl.search}`
  const form = new URLSearchParams({
    paramList,
    code: paramList,
    aliView: finalUrl.searchParams.get('aliView') ?? 'true',
    invoiceDetailMiddleUri,
    shortLinkSource: finalUrl.searchParams.get('shortLinkSource') ?? '1',
    _timestamp: String(Date.now()),
  })

  const detailResponse = await fetchWithTimeout(
    'https://nnfp.jss.com.cn/sapi/scan2/getIvcDetailShow.do',
    {
      method: 'POST',
      headers: {
        ...directFetchHeaders(entryResponse.url),
        origin: 'https://nnfp.jss.com.cn',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    },
  )
  if (!detailResponse?.ok) return undefined

  const detail = (await detailResponse.json().catch(() => undefined)) as
    | {
        status?: string
        data?: {
          invoiceSimpleVo?: {
            orderTotal?: number | string
            saleName?: string
            taxPayerName?: string
            buyername?: string
            url?: string
          }
        }
      }
    | undefined
  if (detail?.status !== '0000') return undefined

  const invoice = detail.data?.invoiceSimpleVo
  const pdfUrl = invoice?.url
  if (!pdfUrl) return undefined

  const pdfResponse = await fetchWithTimeout(pdfUrl, {
    redirect: 'follow',
    headers: directFetchHeaders(entryResponse.url),
  })
  if (!pdfResponse?.ok) return undefined

  const pdf = Buffer.from(await pdfResponse.arrayBuffer())
  if (pdf.subarray(0, 5).toString('utf8') !== '%PDF-') return undefined

  const amountHint =
    invoice.orderTotal === undefined
      ? undefined
      : formatAmount(String(invoice.orderTotal))
  const cateringHint = /(餐饮|餐费|餐饮服务|餐饮费)/.test(
    `${invoice.saleName ?? ''} ${invoice.taxPayerName ?? ''} ${
      invoice.buyername ?? ''
    }`,
  )

  return { pdf, amountHint, cateringHint, nuonuoApi: true }
}

async function fetchPdfFromUrl(
  url: string,
  depth = 0,
  seen = new Set<string>(),
): Promise<FetchedInvoicePdf | undefined> {
  if (depth > 2 || seen.has(url)) return undefined
  seen.add(url)

  if (isDirectNuonuoInvoiceUrl(url)) {
    const nuonuoPdf = await fetchNuonuoPdfFromShortUrl(url)
    if (nuonuoPdf) return nuonuoPdf
  }

  const response = await fetchWithTimeout(url, {
    redirect: 'follow',
    headers: directFetchHeaders(),
  })
  if (!response?.ok) return undefined

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.subarray(0, 5).toString('utf8') === '%PDF-') {
    return { pdf: buffer }
  }

  if (
    depth < 2 &&
    (contentType.includes('text/html') || contentType.includes('text/plain'))
  ) {
    const html = buffer.toString('utf8')
    for (const nestedUrl of candidateInvoiceUrls(html)) {
      const pdf = await fetchPdfFromUrl(nestedUrl, depth + 1, seen)
      if (pdf) return pdf
    }
  }

  return undefined
}

function formatAddresses(
  addresses?: { name?: string; address?: string }[],
): string {
  return (addresses ?? [])
    .map(address => `${address.name ?? ''} ${address.address ?? ''}`.trim())
    .filter(Boolean)
    .join(' ')
}

function parseAmount(text: string): string | undefined {
  const compact = text.replace(/\s+/g, '')
  const patterns = [
    /价税合计.{0,80}(?:小写|小寫)[）)]?[￥¥]?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/,
    /(?:小写|小寫)[）)]?[￥¥]?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/,
  ]

  for (const pattern of patterns) {
    const match = compact.match(pattern)
    if (match?.[1]) {
      return formatAmount(match[1])
    }
  }

  const totalIndex = compact.indexOf('价税合计')
  if (totalIndex >= 0) {
    const window = compact.slice(totalIndex, totalIndex + 160)
    const amount = largestCurrencyAmount(window)
    if (amount) return amount
  }

  return largestCurrencyAmount(compact)
}

function largestCurrencyAmount(text: string): string | undefined {
  const matches = [...text.matchAll(/[￥¥]([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g)]
  const amounts = matches
    .map(match => Number(match[1].replace(/,/g, '')))
    .filter(amount => Number.isFinite(amount) && amount > 0)

  if (amounts.length === 0) return undefined
  return amounts.sort((a, b) => b - a)[0].toFixed(2)
}

function formatAmount(value: string): string | undefined {
  const amount = Number(value.replace(/,/g, ''))
  if (!Number.isFinite(amount) || amount <= 0) return undefined
  return amount.toFixed(2)
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function hasPdfHeader(filePath: string): Promise<boolean> {
  const buffer = await readFile(filePath)
  return buffer.subarray(0, 5).toString('utf8') === '%PDF-'
}

async function uniqueAmountPath(
  outputDir: string,
  amount: string,
): Promise<string> {
  let index = 1
  while (true) {
    const suffix = index === 1 ? '' : `_${String(index).padStart(2, '0')}`
    const candidate = join(outputDir, `${amount}${suffix}.pdf`)
    try {
      await stat(candidate)
      index++
    } catch {
      return candidate
    }
  }
}

async function cleanTempDir(tempDir: string): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true })
  } catch {
    // ignore cleanup failures
  }
}

async function loadExistingHashes(outputDir: string): Promise<Set<string>> {
  const hashes = new Set<string>()
  const files = await readdir(outputDir).catch(() => [])

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.pdf')) continue
    const filePath = join(outputDir, file)
    try {
      hashes.add(await hashFile(filePath))
    } catch {
      // ignore unreadable old files; they will not block new downloads
    }
  }

  return hashes
}

export async function downloadCateringInvoices(
  options: DownloadCateringInvoicesOptions = {},
): Promise<DownloadCateringInvoicesResult> {
  const year = normalizeYear(options.year)
  const since = normalizeSince(options.since, year)
  const outputDir = resolve(
    options.outputDir ?? join('downloads', `qqmail-catering-invoices-${year}`),
  )
  const tempDir = join(outputDir, '.scan-tmp')
  const proxySnapshot = snapshotProxyEnv()

  if (options.directNuonuoRequests ?? true) {
    forceDirectHttpRequests()
  }

  let imap: ImapFlow | undefined

  const summary: Omit<DownloadCateringInvoicesResult, 'filesInOutputDir' | 'files'> =
    {
      year,
      since: since.toISOString(),
      outputDir,
      foldersScanned: 0,
      messagesScanned: 0,
      pdfAttachmentsScanned: 0,
      downloaded: 0,
      downloadedByCateringText: 0,
      downloadedByNuonuoSource: 0,
      downloadedByNuonuoLink: 0,
      duplicateSkipped: 0,
      noAmountSkipped: 0,
      nonCateringSkipped: 0,
      failedDownloads: 0,
      htmlMessagesScanned: 0,
      htmlLinksScanned: 0,
      pdfLinksFound: 0,
      existingFilesIndexed: 0,
      nuonuoApiHits: 0,
    }

  let seenHashes = new Set<string>()

  try {
    await mkdir(tempDir, { recursive: true })

    const { user, authCode } = getQQMailConfig()
    imap = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: {
        user,
        pass: authCode,
      },
      logger: false,
    })

    seenHashes = await loadExistingHashes(outputDir)
    summary.existingFilesIndexed = seenHashes.size

    await imap.connect()
    const mailboxes = await imap.list()
    const folders = mailboxes
      .filter(mailbox => !mailbox.flags?.has('\\Noselect'))
      .filter(mailbox => shouldScanMailbox(mailbox.path, mailbox.specialUse))

    for (const folder of folders) {
      const lock = await imap.getMailboxLock(folder.path)
      try {
        summary.foldersScanned++
        const uids = await imap.search({ since }, { uid: true })
        if (!uids || uids.length === 0) continue

        summary.messagesScanned += uids.length
        const candidates: Candidate[] = []
        const htmlCandidates: HtmlCandidate[] = []

        for await (const msg of imap.fetch(
          uids,
          {
            uid: true,
            bodyStructure: true,
            envelope: true,
          },
          { uid: true },
        )) {
          const nodes = msg.bodyStructure ? walkBodyStructure(msg.bodyStructure) : []
          const from = formatAddresses(msg.envelope?.from)
          const subject = msg.envelope?.subject ?? ''
          const nuonuoSource = isNuonuoSource(from, subject)

          if (nuonuoSource) {
            for (const node of nodes.filter(isHtmlBody)) {
              htmlCandidates.push({
                uid: msg.uid,
                partId: node.part,
              })
            }
          }

          for (const node of nodes.filter(isAttachment).filter(isPdfAttachment)) {
            candidates.push({
              uid: msg.uid,
              partId: node.part,
              filename: getFilename(node),
              size: node.size ?? 0,
              from,
              subject,
              isNuonuoSource: nuonuoSource,
            })
          }
        }

        for (const candidate of candidates) {
          summary.pdfAttachmentsScanned++
          const tempPath = join(
            tempDir,
            `${summary.pdfAttachmentsScanned}-${candidate.uid}-${candidate.partId.replace(/\./g, '-')}.pdf`,
          )

          try {
            const download = await imap.download(
              String(candidate.uid),
              candidate.partId,
              { uid: true },
            )

            if (!download.content) {
              summary.failedDownloads++
              continue
            }

            await pipeline(download.content, createWriteStream(tempPath))

            if (!(await hasPdfHeader(tempPath))) {
              summary.failedDownloads++
              await unlink(tempPath).catch(() => undefined)
              continue
            }

            const hash = await hashFile(tempPath)
            if (seenHashes.has(hash)) {
              summary.duplicateSkipped++
              await unlink(tempPath).catch(() => undefined)
              continue
            }

            const text = extractPdfText(tempPath)
            const matchedByCateringText = isCateringInvoice(text)
            const matchedByNuonuoSource = candidate.isNuonuoSource
            if (!matchedByCateringText && !matchedByNuonuoSource) {
              summary.nonCateringSkipped++
              await unlink(tempPath).catch(() => undefined)
              continue
            }

            const amount = parseAmount(text)
            if (!amount) {
              summary.noAmountSkipped++
              await unlink(tempPath).catch(() => undefined)
              continue
            }

            const destination = await uniqueAmountPath(outputDir, amount)
            await mkdir(dirname(destination), { recursive: true })
            await rename(tempPath, destination)
            seenHashes.add(hash)
            summary.downloaded++
            if (matchedByCateringText) {
              summary.downloadedByCateringText++
            } else if (matchedByNuonuoSource) {
              summary.downloadedByNuonuoSource++
            }
          } catch {
            summary.failedDownloads++
            await unlink(tempPath).catch(() => undefined)
          }
        }

        for (const candidate of htmlCandidates) {
          summary.htmlMessagesScanned++

          try {
            const htmlDownload = await imap.download(
              String(candidate.uid),
              candidate.partId,
              { uid: true },
            )
            if (!htmlDownload.content) {
              summary.failedDownloads++
              continue
            }

            const html = (await streamToBuffer(htmlDownload.content)).toString(
              'utf8',
            )
            const urls = candidateInvoiceUrls(html)
            summary.htmlLinksScanned += urls.length

            for (const url of urls) {
              const fetched = await fetchPdfFromUrl(url)
              if (!fetched) continue
              if (fetched.nuonuoApi) summary.nuonuoApiHits++

              summary.pdfLinksFound++
              const tempPath = join(
                tempDir,
                `link-${summary.pdfLinksFound}-${candidate.uid}.pdf`,
              )
              await writeFile(tempPath, fetched.pdf)

              if (!(await hasPdfHeader(tempPath))) {
                summary.failedDownloads++
                await unlink(tempPath).catch(() => undefined)
                continue
              }

              const hash = await hashFile(tempPath)
              if (seenHashes.has(hash)) {
                summary.duplicateSkipped++
                await unlink(tempPath).catch(() => undefined)
                continue
              }

              const text = extractPdfText(tempPath)
              if (!isCateringInvoice(text) && !fetched.cateringHint) {
                summary.nonCateringSkipped++
                await unlink(tempPath).catch(() => undefined)
                continue
              }

              const amount = parseAmount(text) ?? fetched.amountHint
              if (!amount) {
                summary.noAmountSkipped++
                await unlink(tempPath).catch(() => undefined)
                continue
              }

              const destination = await uniqueAmountPath(outputDir, amount)
              await mkdir(dirname(destination), { recursive: true })
              await rename(tempPath, destination)
              seenHashes.add(hash)
              summary.downloaded++
              summary.downloadedByNuonuoSource++
              summary.downloadedByNuonuoLink++
              break
            }
          } catch {
            summary.failedDownloads++
          }
        }
      } finally {
        lock.release()
      }
    }
  } finally {
    await imap?.logout().catch(() => undefined)
    await cleanTempDir(tempDir)
    restoreProxyEnv(proxySnapshot)
  }

  const files = (await readdir(outputDir).catch(() => []))
    .filter(file => file.toLowerCase().endsWith('.pdf'))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))

  return {
    ...summary,
    filesInOutputDir: files.length,
    files,
  }
}
