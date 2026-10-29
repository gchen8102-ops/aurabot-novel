// 文字小工具：字节解码（UTF-8 / GBK / UTF-16）、HTML 转纯文字、常见实体。
// 纯函数，不碰文件和网络，text.mjs 和 epub.mjs 都用它。

export const ENT = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  middot: '·', bull: '·', copy: '©', reg: '®', trade: '™', deg: '°', times: '×',
  divide: '÷', laquo: '«', raquo: '»', eacute: 'é', egrave: 'è', uuml: 'ü', ouml: 'ö', auml: 'ä',
}

/** 把 QQ / 网页拿到的字节解开。先当 UTF-8，不行再按 GB18030（兼容 GBK）解。 */
export function decodeBuffer(buf) {
  if (!buf || !buf.length) return ''
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3)
  else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2))
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch (error) {}
  try {
    const s = new TextDecoder('gb18030').decode(b)
    if (s && !s.includes('\uFFFD')) return s
  } catch (error) {}
  try {
    return new TextDecoder('gb18030').decode(b)
  } catch (error) {}
  return b.toString('utf8')
}

/** 网页 / XHTML 转纯文字：去掉脚本、样式、标签；<p> / <br> 变成换行；常见实体还原。 */
export function htmlToText(html) {
  try {
    let s = String(html || '')
    s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ')
    s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
    s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    s = s.replace(/<!--[\s\S]*?-->/g, ' ')
    // 注音（ruby）：日文 / 生僻字的拼音不要重复进正文
    s = s.replace(/<rt\b[\s\S]*?<\/rt>/gi, ' ')
    s = s.replace(/<rp\b[\s\S]*?<\/rp>/gi, ' ')
    s = s.replace(/<(?:br|hr)\s*\/?>/gi, '\n')
    s = s.replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|blockquote|dd|dt)>/gi, '\n')
    s = s.replace(/<[^>]+>/g, ' ')
    s = s.replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16), m))
    s = s.replace(/&#(\d+);/g, (m, d) => safeChar(Number(d), m))
    s = s.replace(/&([a-z]+);/gi, (m, k) => ENT[k.toLowerCase()] ?? m)
    return s
  } catch (error) {
    return String(html || '')
  }
}

export function safeChar(code, fallback) {
  try {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return fallback
    return String.fromCodePoint(code)
  } catch (error) {
    return fallback
  }
}

