// epub 拆正文：zip → META-INF/container.xml → OPF → spine 顺序 → XHTML 转文字。
// 纯函数，不碰网络和文件系统。

import { openZip } from './zip.mjs'
import { htmlToText, decodeBuffer, safeChar, ENT } from './textutil.mjs'

/** 是不是 epub：zip 里有 mimetype=application/epub+zip，或者至少有 container.xml。 */
export function isEpub(buf) {
  const zip = openZip(buf)
  if (!zip) return false
  const mime = zip.readText('mimetype').trim()
  if (/^application\/epub\+zip/i.test(mime)) return true
  return zip.has('META-INF/container.xml') && zip.names().some((n) => /\.(?:opf|ncx)$/i.test(n))
}

/** 取一个标签里的属性值；属性有没有引号、单双引号都认。 */
function attr(tag, name) {
  const re = new RegExp(`(?:^|[\\s<])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = re.exec(tag)
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : ''
}

function tags(xml, name) {
  const re = new RegExp(`<${name}\\b[^>]*>`, 'gi')
  return String(xml || '').match(re) || []
}

function unescapeXml(text) {
  return String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d) => safeChar(Number(d), m))
    .replace(/&([a-z]+);/gi, (m, k) => ENT[k.toLowerCase()] ?? m)
}

/** 把 href 变成 zip 里的真实路径（相对 OPF 所在目录，处理 ../ 和 %20）。 */
export function resolveHref(basePath, href) {
  let h = String(href || '').trim()
  if (!h) return ''
  h = h.split('#')[0].split('?')[0]
  try {
    h = decodeURIComponent(h)
  } catch (error) {}
  const base = String(basePath || '').split('/').slice(0, -1).filter(Boolean)
  const parts = [...base]
  for (const piece of h.replace(/\\/g, '/').split('/')) {
    if (!piece || piece === '.') continue
    if (piece === '..') parts.pop()
    else parts.push(piece)
  }
  return parts.join('/')
}

/** 读 OPF：书名、每个 manifest 文件、spine 顺序。 */
export function parseOpf(xml, opfPath) {
  const text = String(xml || '')
  const metaBlock = (/<metadata\b[\s\S]*?<\/metadata>/i.exec(text) || [])[0] || text
  let title = ''
  for (const m of metaBlock.matchAll(/<(?:dc:)?title\b[^>]*>([\s\S]*?)<\/(?:dc:)?title>/gi)) {
    const v = unescapeXml(m[1]).replace(/\s+/g, ' ').trim()
    if (v) { title = v; break }
  }
  const items = new Map()
  for (const tag of tags(text, 'item')) {
    const id = attr(tag, 'id')
    if (!id) continue
    items.set(id, {
      id,
      href: attr(tag, 'href'),
      path: resolveHref(opfPath, attr(tag, 'href')),
      type: attr(tag, 'media-type').toLowerCase(),
      properties: attr(tag, 'properties').toLowerCase(),
    })
  }
  const spine = []
  const spineBlock = (/<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(text) || [])[1] || ''
  for (const tag of spineBlock.match(/<itemref\b[^>]*>/gi) || []) {
    const idref = attr(tag, 'idref')
    const linear = attr(tag, 'linear').toLowerCase()
    if (!idref || linear === 'no') continue
    const item = items.get(idref)
    if (item) spine.push(item)
  }
  return { title, items, spine, opfPath }
}

function isHtml(item) {
  return /x?html/i.test(item.type) || /\.(?:x?html?|htm)$/i.test(item.path)
}

/** 一本书的正文：按 spine 顺序把每个 XHTML 转成文字，章节之间空一行。 */
export function epubToText(buf) {
  const zip = openZip(buf)
  if (!zip) throw new Error('不是有效的 EPUB 文件')

  const enc = zip.readText('META-INF/encryption.xml')
  if (enc && /\.(?:x?html?|htm|opf|ncx)\b/i.test(enc)) {
    throw new Error('这本 EPUB 有 DRM 加密，正文读不出来')
  }

  const container = zip.readText('META-INF/container.xml')
  let opfPath = ''
  if (container) {
    const files = container.match(/<rootfile\b[^>]*>/gi) || []
    const pick = files.find((t) => /oebps-package|\.opf/i.test(t)) || files[0]
    if (pick) opfPath = attr(pick, 'full-path')
  }
  if (!opfPath) opfPath = zip.names().find((n) => /\.opf$/i.test(n)) || ''
  if (!opfPath || !zip.has(opfPath)) throw new Error('EPUB 里找不到书的目录（OPF）')

  const opf = parseOpf(zip.readText(opfPath), opfPath)
  let list = opf.spine.filter(isHtml)
  if (!list.length) {
    // spine 缺失 / 写坏了：退而求其次，把所有正文页按文件名顺序读一遍
    list = zip.names()
      .filter((n) => /\.(?:x?html?|htm)$/i.test(n))
      .filter((n) => !/(?:^|\/)(?:nav|toc|cover|titlepage)(?:\.|$)/i.test(n))
      .sort()
      .map((path) => ({ id: path, href: path, path, type: 'application/xhtml+xml', properties: '' }))
  }

  const chapters = []
  for (const item of list) {
    if (/(?:^|\s)nav(?:\s|$)/i.test(item.properties)) continue
    const raw = zip.read(item.path)
    if (!raw || !raw.length) continue
    const html = looksLikeUtf8(raw) ? raw.toString('utf8') : decodeBuffer(raw)
    const text = htmlToText(html).trim()
    if (text.replace(/\s+/g, '').length >= 4) chapters.push(text)
  }
  if (!chapters.length) throw new Error('EPUB 里没拆出正文（可能只有图片）')

  return {
    text: chapters.join('\n\n'),
    title: opf.title,
    chapters: chapters.length,
    format: 'epub',
  }
}

function looksLikeUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch (error) {
    return false
  }
}
