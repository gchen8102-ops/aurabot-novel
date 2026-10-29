// 小说文本工具：Word（docx）拆正文、按格式选解析器（epub / pdf 各自的文件）、
// 去广告、切段、抽样、从文件名猜书名。纯函数，不碰文件和网络，方便单独测。

import { openZip, looksLikeZip } from './zip.mjs'
import { decodeBuffer, htmlToText, ENT } from './textutil.mjs'
import { epubToText as readEpub, isEpub } from './epub.mjs'
import { pdfToText as readPdf, isPdf } from './pdf.mjs'

export { looksLikeZip, decodeBuffer, htmlToText }

/** Word（.docx）正文转纯文字；不是 docx 就返回空串。 */
export function docxToText(buf) {
  const zip = openZip(buf)
  if (!zip) return ''
  const xml = zip.read('word/document.xml')
  if (!xml || !xml.length) return ''
  let s = xml.toString('utf8')
  s = s.replace(/<w:tab\b[^>]*\/?>/g, '\t')
  s = s.replace(/<w:(?:br|cr)\b[^>]*\/?>/g, '\n')
  s = s.replace(/<\/w:p>/g, '\n')
  s = s.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '')
  s = s.replace(/<[^>]+>/g, '')
  s = s.replace(/&#x([0-9a-f]+);/gi, (m, h) => safeCharcode(parseInt(h, 16), m))
  s = s.replace(/&#(\d+);/g, (m, d) => safeCharcode(Number(d), m))
  s = s.replace(/&([a-z]+);/gi, (m, k) => ENT[k.toLowerCase()] ?? m)
  return s
}

function safeCharcode(code, fallback) {
  try {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return fallback
    return String.fromCodePoint(code)
  } catch (error) {
    return fallback
  }
}

// ---------------- 按格式选解析器 ----------------

/** epub 拆正文（兼容旧调用；失败返回空串，要看原因用 documentText）。 */
export function epubToText(buf) {
  try {
    return readEpub(buf).text
  } catch (error) {
    return ''
  }
}

/** pdf 抽文字（兼容旧调用；失败返回空串，要看原因用 documentText）。 */
export function pdfToText(buf) {
  try {
    return readPdf(buf).text
  } catch (error) {
    return ''
  }
}

/**
 * 按格式自动拆正文，返回 { text, kind, error?, title?, pages?, chapters? }。
 *
 * kind：pdf / epub / docx / html / txt / zip。
 * error：给人看的解释（扫描版 PDF、加密 PDF、字体没编码表……）。
 */
export function documentText(buf, name = '') {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (!b.length) return { text: '', kind: '' }

  if (isPdf(b)) {
    try {
      const r = readPdf(b)
      return { text: r.text, kind: 'pdf', pages: r.pages }
    } catch (error) {
      return { text: '', kind: 'pdf', error: error.message }
    }
  }

  if (looksLikeZip(b)) {
    if (isEpub(b)) {
      try {
        const r = readEpub(b)
        return { text: r.text, kind: 'epub', title: r.title, chapters: r.chapters }
      } catch (error) {
        return { text: '', kind: 'epub', error: error.message }
      }
    }
    const docx = docxToText(b)
    if (docx.trim()) return { text: docx, kind: 'docx' }
    return { text: '', kind: 'zip' }
  }

  let text = decodeBuffer(b)
  const kind = /^\s*(?:<!doctype|<html|<head|<body)/i.test(text.slice(0, 400)) ? 'html' : 'txt'
  if (kind === 'html') text = htmlToText(text)
  return { text, kind }
}

// 常见的盗版站广告 / 导航行，整行丢掉
const AD_LINE = /^(?:本章未完|请收藏|请记住本站|记住本站|最新章节|加入书签|手机版阅读|返回目录|目录页|上一章|下一章|章节报错|笔趣阁|顶点小说|www\.|https?:\/\/|m\.|wap\.)/i

/** 清洗正文：统一换行、去掉零宽字符、去广告行、合并空行。 */
export function cleanText(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .split('\n')
  const out = []
  for (let line of lines) {
    line = line.replace(/[ \t]+/g, ' ').trim()
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    if (AD_LINE.test(line)) continue
    if (line.length < 130 && /(https?:\/\/|www\.)/i.test(line) && !/[。！？]{1}/.test(line)) continue
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 按段落切成大约 size 字一段；超长段落按句子再切。 */
export function splitChunks(text, size = 4500) {
  const n = Math.max(800, Number(size) || 4500)
  const paras = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean)
  const out = []
  let cur = ''
  const flush = () => {
    if (cur.trim()) out.push(cur.trim())
    cur = ''
  }
  for (const p of paras) {
    if (p.length > n * 1.8) {
      flush()
      for (const piece of hardSplit(p, n)) out.push(piece)
      continue
    }
    if (cur.length + p.length + 1 > n) flush()
    cur += (cur ? '\n' : '') + p
  }
  flush()
  return out.length ? out : [String(text || '').trim()].filter(Boolean)
}

function hardSplit(p, size) {
  const out = []
  let s = p
  while (s.length > size * 1.5) {
    const win = s.slice(0, size)
    let k = Math.max(win.lastIndexOf('。'), win.lastIndexOf('！'), win.lastIndexOf('？'), win.lastIndexOf('…'), win.lastIndexOf('\n'))
    if (k < size * 0.5) k = size - 1
    out.push(s.slice(0, k + 1).trim())
    s = s.slice(k + 1)
  }
  if (s.trim()) out.push(s.trim())
  return out
}

/** 书太长时均匀抽样：总数不超过 max 时全读，否则首尾都读、中间等距挑。 */
export function pickIndices(total, max) {
  const t = Math.max(0, Number(total) || 0)
  const m = Math.max(1, Number(max) || 1)
  if (t <= m) return Array.from({ length: t }, (_, i) => i)
  const set = new Set()
  for (let i = 0; i < m; i++) set.add(Math.round((i * (t - 1)) / (m - 1)))
  return [...set].sort((a, b) => a - b)
}

/** 从文件名猜书名：去扩展名、去「全本」「完结」「作者：xxx」这类尾巴。 */
export function titleFromFilename(name) {
  let s = String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '')
  s = s.replace(/[（(【\[]\s*(?:全本|完结|校对|精校|无删减|txt|下载|精校版)?\s*[)）】\]]/gi, '')
  s = s.replace(/[（(【\[]\s*(?:作者|作\s*者)\s*[:：][^)）】\]]*[)）】\]]/gi, '')
  s = s.replace(/(?:作者|作\s*者)\s*[:：].*$/, '')
  s = s.replace(/[_\s-]*(?:全本|完结|校对版|精校版|txt|下载)$/i, '')
  return s.trim().slice(0, 80) || '未命名小说'
}

/** 从网址猜书名：取最后一段路径，去掉扩展名和查询串。 */
export function titleFromUrl(url) {
  try {
    const u = new URL(String(url))
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
    const name = last.replace(/\.(?:txt|html?|php|aspx?|epub|pdf)$/i, '')
    return titleFromFilename(name || u.hostname)
  } catch (error) {
    return '未命名小说'
  }
}

/** 做成能当文件名 / id 的样子（保留中文）。 */
export function slug(text) {
  const s = String(text || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
  return s || 'book'
}

export function cut(text, n) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  const max = Math.max(1, Number(n) || 100)
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** 去掉一句话外面已经带了的引号（模型抄原话时常自带），显示时再统一加。 */
export function stripQuote(text) {
  let s = String(text ?? '').trim()
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^["'“”「」『』]+/, '').replace(/["'“”「」『』]+$/, '').trim()
    if (next === s) break
    s = next
  }
  return s
}

export function charsLabel(n) {
  const v = Math.max(0, Number(n) || 0)
  if (v < 10000) return `${v} 字`
  return `${(v / 10000).toFixed(v < 100000 ? 1 : 0)} 万字`
}
