export type QQMailConfig = {
  user: string
  authCode: string
}

export type EmailSummary = {
  uid: number
  subject: string
  from: { address: string; name: string }[]
  date: string
  dateIso: string
  timestamp: number
  receivedAt: string
  sentAt: string
  hasAttachments: boolean
  isRead: boolean
}

export type QueryEmailsResult = {
  emails: EmailSummary[]
  totalMatched: number
}

export type AttachmentInfo = {
  filename: string
  size: number
  partId: string
}

export type EmailDetail = {
  uid: number
  subject: string
  from: { address: string; name: string }[]
  to: { address: string; name: string }[]
  date: string
  dateIso: string
  timestamp: number
  receivedAt: string
  sentAt: string
  textBody: string
  htmlBody: string
  attachments: AttachmentInfo[]
}
