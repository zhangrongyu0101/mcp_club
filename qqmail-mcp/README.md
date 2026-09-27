# qqmail-mcp

一个用于 **QQ 邮箱** 的 [MCP](https://modelcontextprotocol.io/) 服务器，通过 IMAP 提供邮件查询、阅读、移动、归档、附件下载，以及**批量下载餐饮发票 PDF**（含诺诺/诺诺网短链接解析）等工具。

## 功能（Tools）

| 工具 | 说明 |
| --- | --- |
| `qqmail_query_emails` | 按文件夹/时间/未读/关键词搜索邮件，返回摘要列表（uid、主题、发件人、时间、是否有附件） |
| `qqmail_get_email` | 按 uid 读取单封邮件详情（正文 text/html、附件列表） |
| `qqmail_move_emails` | 将一封或多封邮件移动到目标文件夹 |
| `qqmail_archive_emails` | 归档邮件到 Archive 文件夹（不存在则自动创建） |
| `qqmail_download_attachment` | 下载指定邮件的附件到本地路径（带内容类型/文件名校验） |
| `qqmail_download_catering_invoices` | 扫描指定年份的邮件，批量下载餐饮发票 PDF：支持普通 PDF 附件和诺诺 HTML 短链接（直连诺诺发票 API 解析、绕过代理、按 PDF 哈希去重、按金额命名） |

## 前置条件

1. **开启 QQ 邮箱 IMAP 服务并获取授权码**：
   QQ 邮箱网页版 → 设置 → 账户 → POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务 → 开启 IMAP/SMTP 服务，生成**授权码**（不是 QQ 密码）。
2. （可选，发票下载用）安装 `pdftotext`（poppler），用于提取 PDF 文本判断是否为餐饮发票并解析金额。未安装时相关文本识别会被跳过。

## 配置凭证

通过环境变量提供凭证（推荐）：

```bash
QQMAIL_USER=123456789@qq.com
QQMAIL_AUTH_CODE=你的IMAP授权码
```

如果环境变量缺失，服务器会回退读取 `~/.claude.json` 中的 `mcpServers.qqmail.env`。

## 安装与构建

```bash
npm install
npm run build      # 编译到 dist/
npm run typecheck  # 仅类型检查
```

开发模式直接运行（无需构建）：

```bash
npm run dev        # 使用 tsx 运行 src/server.ts
```

## 在 MCP 客户端中使用

### Claude Code / Claude Desktop

在配置中添加（Claude Code：`claude mcp add`，或编辑 `~/.claude.json`）：

```json
{
  "mcpServers": {
    "qqmail": {
      "command": "node",
      "args": ["E:/code/qqmail-mcp/dist/server.js"],
      "env": {
        "QQMAIL_USER": "123456789@qq.com",
        "QQMAIL_AUTH_CODE": "你的IMAP授权码"
      }
    }
  }
}
```

开发时也可以直接用 tsx：

```json
{
  "mcpServers": {
    "qqmail": {
      "command": "npx",
      "args": ["tsx", "E:/code/qqmail-mcp/src/server.ts"],
      "env": {
        "QQMAIL_USER": "123456789@qq.com",
        "QQMAIL_AUTH_CODE": "你的IMAP授权码"
      }
    }
  }
}
```

## 发票下载说明

`qqmail_download_catering_invoices` 会：

- 扫描所有收件类文件夹（跳过已发送/草稿/垃圾箱等），查找指定年份以来的邮件；
- 下载所有 PDF 附件，用 `pdftotext` 提取文本，匹配「发票」+「餐饮」关键字；
- 对诺诺（nuonuo / nnfp.jss.com.cn）来源的邮件，解析 HTML 正文中的短链接，直接调用诺诺发票 API 获取 PDF（默认临时清除 `HTTP_PROXY`/`HTTPS_PROXY` 等代理变量直连）；
- 按 SHA-256 哈希去重，从发票文本中解析「价税合计（小写）」金额，并以金额命名保存（如 `123.45.pdf`，重名加后缀）；
- 默认输出到 `downloads/qqmail-catering-invoices-<year>/`。

## License

MIT
