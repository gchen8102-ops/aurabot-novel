// PDF 抽文字：自己解 xref / 对象流 / FlateDecode / ToUnicode，不装任何依赖。
//
// 只做「读小说」需要的事：把每页正文按阅读顺序拼出来。
// 不支持：加密 PDF、扫描版（没有文字层）、需要 OCR 的图片页 —— 这些会给出人话解释。
//
// 参考 PDF 1.7 规范：7.5 对象、7.4 过滤器、9.10 文字、5.9 对象流、7.9.5 ToUnicode。

import { inflateSync, inflateRawSync } from 'node:zlib'

// ---------------- 扫描器 ----------------

const WS = new Uint8Array(256)
for (const c of [0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]) WS[c] = 1
const DELIM = new Uint8Array(256)
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1

const isWs = (c) => c !== undefined && WS[c] === 1
const isDelim = (c) => c !== undefined && DELIM[c] === 1
const isDigit = (c) => c >= 0x30 && c <= 0x39

class Cursor {
  constructor(s, i = 0) {
    this.s = s
    this.i = i
  }
  eof() {
    return this.i >= this.s.length
  }
  skip() {
    const s = this.s
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i)
      if (isWs(c)) this.i++
      else if (c === 0x25 /* % */) {
        while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r') this.i++
      } else break
    }
  }
}

function parseValue(cur) {
  cur.skip()
  const s = cur.s
  if (cur.eof()) return { t: 'null' }
  const c = s[cur.i]

  if (c === '<') {
    if (s[cur.i + 1] === '<') {
      cur.i += 2
      const dict = new Map()
      for (;;) {
        cur.skip()
        if (cur.eof()) break
        if (s[cur.i] === '>' && s[cur.i + 1] === '>') { cur.i += 2; break }
        const key = parseValue(cur)
        if (key.t !== 'name') break
        const val = parseValue(cur)
        dict.set(key.v, val)
      }
      return { t: 'dict', v: dict }
    }
    return parseHexString(cur)
  }
  if (c === '(') return parseLiteralString(cur)
  if (c === '[') {
    cur.i++
    const arr = []
    for (;;) {
      cur.skip()
      if (cur.eof()) break
      if (s[cur.i] === ']') { cur.i++; break }
      const before = cur.i
      arr.push(parseValue(cur))
      if (cur.i === before) { cur.i++; }
    }
    return { t: 'arr', v: arr }
  }
  if (c === '/') {
    cur.i++
    let name = ''
    while (cur.i < s.length) {
      const ch = s.charCodeAt(cur.i)
      if (isWs(ch) || isDelim(ch)) break
      if (ch === 0x23 && /^[0-9a-fA-F]{2}$/.test(s.slice(cur.i + 1, cur.i + 3))) {
        name += String.fromCharCode(parseInt(s.slice(cur.i + 1, cur.i + 3), 16))
        cur.i += 3
        continue
      }
      name += s[cur.i++]
    }
    return { t: 'name', v: name }
  }
  if (c === '>' && s[cur.i + 1] === '>') { cur.i += 2; return { t: 'null' } }
  if (isDigit(c.charCodeAt(0)) || c === '-' || c === '+' || c === '.') {
    const m = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(cur.i, cur.i + 40))
    if (m) {
      cur.i += m[0].length
      const num = Number(m[0])
      // 引用：12 0 R
      const save = cur.i
      cur.skip()
      let j = cur.i
      while (j < s.length && isDigit(s.charCodeAt(j))) j++
      if (j > cur.i) {
        const gen = Number(s.slice(cur.i, j))
        let k = j
        while (k < s.length && isWs(s.charCodeAt(k))) k++
        if (s[k] === 'R' && (k + 1 >= s.length || isWs(s.charCodeAt(k + 1)) || isDelim(s.charCodeAt(k + 1)))) {
          cur.i = k + 1
          return { t: 'ref', num, gen }
        }
      }
      cur.i = save
      return { t: 'num', v: num }
    }
  }
  const kw = /^(?:true|false|null)\b/.exec(s.slice(cur.i, cur.i + 8))
  if (kw) {
    cur.i += kw[0].length
    if (kw[0] === 'null') return { t: 'null' }
    return { t: 'bool', v: kw[0] === 'true' }
  }
  // 其它关键字：跳过一个记号
  const word = /^[^\s<>[\]{}/()%]+/.exec(s.slice(cur.i, cur.i + 32))
  cur.i += word ? word[0].length : 1
  return { t: 'kw', v: word ? word[0] : s[cur.i - 1] }
}

function parseHexString(cur) {
  const s = cur.s
  cur.i++ // <
  let hex = ''
  while (cur.i < s.length && s[cur.i] !== '>') {
    const ch = s[cur.i++]
    if (/[0-9a-fA-F]/.test(ch)) hex += ch
  }
  cur.i++ // >
  if (hex.length % 2) hex += '0'
  return { t: 'str', v: hexToString(hex), hex: true }
}

function hexToString(hex) {
  let out = ''
  for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
  return out
}

function parseLiteralString(cur) {
  const s = cur.s
  cur.i++ // (
  let out = ''
  let depth = 1
  while (cur.i < s.length) {
    const c = s[cur.i++]
    if (c === '\\') {
      const n = s[cur.i++]
      if (n === 'n') out += '\n'
      else if (n === 'r') out += '\r'
      else if (n === 't') out += '\t'
      else if (n === 'b') out += '\b'
      else if (n === 'f') out += '\f'
      else if (n === '(' || n === ')' || n === '\\') out += n
      else if (n === '\r') { if (s[cur.i] === '\n') cur.i++ }
      else if (n === '\n') {}
      else if (n >= '0' && n <= '7') {
        let oct = n
        while (oct.length < 3 && s[cur.i] >= '0' && s[cur.i] <= '7') oct += s[cur.i++]
        out += String.fromCharCode(parseInt(oct, 8) & 0xff)
      } else out += n ?? ''
      continue
    }
    if (c === '(') { depth++; out += c; continue }
    if (c === ')') {
      depth--
      if (!depth) break
      out += c
      continue
    }
    out += c
  }
  return { t: 'str', v: out }
}

// ---------------- 过滤器 ----------------

function inflateSafe(data) {
  for (const fn of [inflateSync, inflateRawSync]) {
    try {
      return fn(data)
    } catch (error) {}
  }
  try {
    return inflateSync(data, { finishFlush: 2 })
  } catch (error) {}
  return null
}

function ascii85(data) {
  const s = data.toString('latin1').replace(/\s+/g, '')
  let out = Buffer.alloc(0)
  const chunks = []
  let group = []
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '~') break
    if (c === 'z' && !group.length) { chunks.push(Buffer.alloc(4)); continue }
    const v = c.charCodeAt(0) - 33
    if (v < 0 || v > 84) continue
    group.push(v)
    if (group.length === 5) {
      let n = 0
      for (const g of group) n = n * 85 + g
      chunks.push(Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]))
      group = []
    }
  }
  if (group.length) {
    const take = group.length
    while (group.length < 5) group.push(84)
    let n = 0
    for (const g of group) n = n * 85 + g
    const b = Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
    chunks.push(b.subarray(0, take - 1))
  }
  out = Buffer.concat(chunks)
  return out
}

function asciiHex(data) {
  const s = data.toString('latin1').replace(/\s+/g, '')
  const end = s.indexOf('>')
  const hex = (end >= 0 ? s.slice(0, end) : s).replace(/[^0-9a-fA-F]/g, '')
  return Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex')
}

function lzw(data, earlyChange = 1) {
  const out = []
  let dict = []
  const reset = () => {
    dict = []
    for (let i = 0; i < 256; i++) dict.push(String.fromCharCode(i))
    dict.push(null, null) // 256 clear, 257 eod
  }
  reset()
  let codeLen = 9
  let bitBuf = 0
  let bitCount = 0
  let prev = null
  for (const byte of data) {
    bitBuf = (bitBuf << 8) | byte
    bitCount += 8
    while (bitCount >= codeLen) {
      const code = (bitBuf >>> (bitCount - codeLen)) & ((1 << codeLen) - 1)
      bitCount -= codeLen
      if (code === 256) { reset(); codeLen = 9; prev = null; continue }
      if (code === 257) { bitCount = 0; break }
      let entry
      if (code < dict.length && dict[code] != null) entry = dict[code]
      else if (prev != null) entry = prev + prev[0]
      else break
      out.push(entry)
      if (prev != null) dict.push(prev + entry[0])
      prev = entry
      const size = dict.length + earlyChange
      if (size >= 4096) codeLen = 12
      else if (size >= 2048) codeLen = 12
      else if (size >= 1024) codeLen = 11
      else if (size >= 512) codeLen = 10
      else codeLen = 9
    }
  }
  return Buffer.from(out.join(''), 'latin1')
}

function runLength(data) {
  const out = []
  let i = 0
  while (i < data.length) {
    const n = data[i++]
    if (n === 128) break
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++])
    } else {
      const b = data[i++]
      for (let k = 0; k < 257 - n; k++) out.push(b)
    }
  }
  return Buffer.from(out)
}

function applyPredictor(data, parms) {
  if (!parms) return data
  const predictor = num(parms.get('Predictor'))
  if (!predictor || predictor < 2) return data
  const colors = Math.max(1, num(parms.get('Colors')) || 1)
  const bpc = Math.max(1, num(parms.get('BitsPerComponent')) || 8)
  const columns = Math.max(1, num(parms.get('Columns')) || 1)
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowLen = Math.ceil((colors * bpc * columns) / 8)

  if (predictor === 2) {
    // TIFF predictor：只处理 8 位的情况
    if (bpc !== 8) return data
    const rows = Math.floor(data.length / rowLen)
    const out = Buffer.from(data)
    for (let r = 0; r < rows; r++) {
      const base = r * rowLen
      for (let i = bpp; i < rowLen; i++) out[base + i] = (out[base + i] + out[base + i - bpp]) & 0xff
    }
    return out
  }

  // PNG predictor：每行前面有一个 filter 字节
  const rows = Math.floor(data.length / (rowLen + 1))
  const out = Buffer.alloc(rows * rowLen)
  let prev = Buffer.alloc(rowLen)
  for (let r = 0; r < rows; r++) {
    const src = data.subarray(r * (rowLen + 1), (r + 1) * (rowLen + 1))
    const type = src[0]
    const row = Buffer.from(src.subarray(1, rowLen + 1))
    for (let i = 0; i < row.length; i++) {
      const left = i >= bpp ? row[i - bpp] : 0
      const up = prev[i]
      const upLeft = i >= bpp ? prev[i - bpp] : 0
      let val = row[i]
      if (type === 1) val = (val + left) & 0xff
      else if (type === 2) val = (val + up) & 0xff
      else if (type === 3) val = (val + ((left + up) >> 1)) & 0xff
      else if (type === 4) val = (val + paeth(left, up, upLeft)) & 0xff
      row[i] = val
    }
    row.copy(out, r * rowLen)
    prev = row
  }
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function decodeStream(dict, data, resolve) {
  if (!data || !data.length) return data
  let filters = resolve(dict.get('Filter'))
  let parms = resolve(dict.get('DecodeParms'))
  const list = []
  if (filters) {
    const arr = filters.t === 'arr' ? filters.v : [filters]
    for (const f of arr) {
      const v = resolve(f)
      if (v && v.t === 'name') list.push(v.v)
    }
  }
  const parmList = []
  if (parms) {
    const arr = parms.t === 'arr' ? parms.v : [parms]
    for (const p of arr) parmList.push(resolve(p))
  }

  let out = data
  for (let idx = 0; idx < list.length; idx++) {
    const filter = list[idx]
    const parm = parmList[idx] && parmList[idx].t === 'dict' ? parmList[idx].v : null
    const name = String(filter).replace(/^\//, '')
    if (/^FlateDecode$/i.test(name)) {
      const inf = inflateSafe(out)
      if (!inf) return null
      out = applyPredictor(inf, parm)
    } else if (/^ASCII85Decode$/i.test(name)) {
      out = ascii85(out)
    } else if (/^ASCIIHexDecode$/i.test(name)) {
      out = asciiHex(out)
    } else if (/^LZWDecode$/i.test(name)) {
      out = applyPredictor(lzw(out, num(parm?.get('EarlyChange')) ?? 1), parm)
    } else if (/^RunLengthDecode$/i.test(name)) {
      out = runLength(out)
    } else {
      return null // 图片类过滤器（DCT / JPX / JBIG2 / CCITT）
    }
  }
  return out
}

function num(v) {
  if (!v) return null
  if (v.t === 'num') return v.v
  if (v.t === 'name') return Number(v.v)
  return null
}

// ---------------- 文档 ----------------

export function isPdf(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (b.length < 5) return false
  const head = b.toString('latin1', 0, Math.min(1024, b.length))
  return head.includes('%PDF-')
}

export function parsePdf(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  if (!isPdf(b)) throw new Error('不是 PDF 文件')
  const s = b.toString('latin1')
  const objects = new Map()

  // 1) 粗扫所有 "N G obj"，跳过流内部，别把二进制里的 obj 当真
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  let m
  let lastEnd = 0
  while ((m = re.exec(s))) {
    if (m.index < lastEnd) continue
    const numId = Number(m[1])
    const cur = new Cursor(s, re.lastIndex)
    const value = parseValue(cur)
    let stream = null
    let after = cur.i
    cur.skip()
    if (s.startsWith('stream', cur.i)) {
      let start = cur.i + 6
      if (s[start] === '\r') start++
      if (s[start] === '\n') start++
      let len = null
      const lv = value.t === 'dict' ? value.v.get('Length') : null
      if (lv && lv.t === 'num') len = lv.v
      else if (lv && lv.t === 'ref') {
        const target = objects.get(lv.num)
        if (target && target.value.t === 'num') len = target.value.v
      }
      let end = len && start + len <= s.length ? start + len : -1
      if (end < 0 || !s.startsWith('endstream', skipWs(s, end))) {
        end = s.indexOf('endstream', start)
        if (end < 0) end = s.length
      }
      const dataEnd = end
      stream = { data: b.subarray(start, dataEnd) }
      const afterStream = s.indexOf('endstream', dataEnd)
      lastEnd = afterStream < 0 ? dataEnd : afterStream + 9
      after = lastEnd
    } else {
      lastEnd = Math.max(cur.i, m.index + m[0].length)
      after = lastEnd
    }
    if (!objects.has(numId)) objects.set(numId, { num: numId, value, stream })
    re.lastIndex = Math.max(after, re.lastIndex)
  }

  if (!objects.size) throw new Error('PDF 结构读不出来（可能文件损坏）')

  // 把引用解成「对象记录」（带 stream），字体 / 页面内容都要从这里拿原始数据
  const getObj = (v) => {
    let rec = null
    let cur = v
    for (let i = 0; i < 32 && cur && cur.t === 'ref'; i++) {
      rec = objects.get(cur.num) || null
      cur = rec ? rec.value : null
    }
    if (!rec && v && v.t === 'dict') rec = { value: v, stream: null }
    return rec
  }
  const resolve = (v) => {
    let cur = v
    for (let i = 0; i < 32 && cur && cur.t === 'ref'; i++) {
      const target = objects.get(cur.num)
      cur = target ? target.value : null
    }
    return cur
  }
  const dictOf = (v) => {
    const r = resolve(v)
    return r && r.t === 'dict' ? r.v : null
  }
  const nameOf = (v) => {
    const r = resolve(v)
    return r && r.t === 'name' ? r.v : ''
  }
  const numOf = (v) => {
    const r = resolve(v)
    return r && r.t === 'num' ? r.v : null
  }

  // 2) 展开对象流（字体、页面经常藏在里面）
  for (let round = 0; round < 2; round++) {
    for (const obj of [...objects.values()]) {
      if (!obj.stream || obj.value.t !== 'dict') continue
      if (nameOf(obj.value.v.get('Type')) !== 'ObjStm') continue
      const data = decodeStream(obj.value.v, obj.stream.data, resolve)
      if (!data) continue
      const n = numOf(obj.value.v.get('N')) || 0
      const first = numOf(obj.value.v.get('First')) || 0
      const head = data.toString('latin1', 0, Math.min(first, data.length)).trim().split(/\s+/)
      for (let i = 0; i < n; i++) {
        const objNum = Number(head[i * 2])
        const off = Number(head[i * 2 + 1])
        if (!Number.isFinite(objNum) || !Number.isFinite(off)) continue
        if (objects.has(objNum)) continue
        const c2 = new Cursor(data.toString('latin1'), first + off)
        try {
          objects.set(objNum, { num: objNum, value: parseValue(c2), stream: null })
        } catch (error) {}
      }
    }
  }

  // 3) 加密？（/Encrypt 只会出现在文件尾部的 trailer / xref 流里，别去正文里误判）
  const tail = s.slice(Math.max(0, s.length - 8192))
  if (/(?:^|[\s>])\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/.test(tail)) {
    throw new Error('这个 PDF 加密了（有密码或权限保护），读不出正文')
  }

  // 4) 页树
  const rootMatch = [...s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop()
  let root = rootMatch ? objects.get(Number(rootMatch[1])) : null
  if (!root) {
    for (const obj of objects.values()) {
      if (obj.value.t === 'dict' && nameOf(obj.value.v.get('Type')) === 'Catalog') { root = obj; break }
    }
  }

  const pages = []
  const seen = new Set()
  const walk = (token, inherited, depth) => {
    const node = resolve(token)
    if (!node || node.t !== 'dict' || depth > 64 || pages.length > 20000) return
    const dict = node.v
    const resources = dictOf(dict.get('Resources')) || inherited
    const type = nameOf(dict.get('Type'))
    if (type === 'Pages') {
      const kids = resolve(dict.get('Kids'))
      if (!kids || kids.t !== 'arr') return
      for (const kid of kids.v) {
        const key = kid && kid.t === 'ref' ? kid.num : null
        if (key != null) {
          if (seen.has(key)) continue
          seen.add(key)
        }
        walk(kid, resources, depth + 1)
      }
      return
    }
    if (type === 'Page' || (!type && dict.has('Contents') && dict.has('MediaBox'))) {
      pages.push({ dict, resources })
    }
  }
  if (root) walk(root.value.v.get('Pages'), null, 0)
  if (!pages.length) {
    // 没有页树（少见）：退化成「所有 /Type /Page」按对象号排
    for (const obj of [...objects.values()].sort((a, b) => a.num - b.num)) {
      if (obj.value.t === 'dict' && nameOf(obj.value.v.get('Type')) === 'Page') {
        pages.push({ dict: obj.value.v, resources: dictOf(obj.value.v.get('Resources')) })
      }
    }
  }
  if (!pages.length) throw new Error('PDF 里找不到页面')

  // 5) 逐页抽文字
  const parts = []
  let unknownChars = 0
  const fonts = new Map() // 字体对象号 → 解码器，同一字体别重复解析
  for (const page of pages) {
    const res = page.resources
    const fontDict = res ? dictOf(res.get('Font')) : null
    const pageFonts = new Map()
    if (fontDict) {
      for (const [fontName, fontRef] of fontDict) {
        const key = fontRef && fontRef.t === 'ref' ? fontRef.num : null
        let decoder = key != null ? fonts.get(key) : null
        if (!decoder) {
          const fontObj = resolve(fontRef)
          if (!fontObj || fontObj.t !== 'dict') continue
          decoder = makeFontDecoder(fontObj.v, resolve, getObj)
          if (key != null) fonts.set(key, decoder)
        }
        pageFonts.set(fontName, decoder)
      }
    }
    const content = pageContent(page.dict, getObj, resolve)
    if (!content) continue
    const result = extractText(content, pageFonts)
    unknownChars += result.unknown
    const text = tidy(result.text)
    if (text) parts.push(text)
  }

  const text = parts.join('\n\n')
  return {
    text,
    pages: pages.length,
    unknownChars,
    looksScanned: text.replace(/\s+/g, '').length < 100,
  }
}

function skipWs(s, i) {
  while (i < s.length && isWs(s.charCodeAt(i))) i++
  return i
}

/** 一页的内容流：/Contents 可能是单个流，也可能是流组成的数组，解码后拼起来再抽。 */
function pageContent(pageDict, getObj, resolve) {
  const out = []
  const collect = (val) => {
    const rec = getObj(val)
    if (!rec) return
    const v = rec.value
    if (v && v.t === 'arr') {
      for (const item of v.v) collect(item)
      return
    }
    if (!rec.stream || !rec.stream.data || !rec.stream.data.length) return
    const dict = v && v.t === 'dict' ? v.v : null
    const decoded = dict ? decodeStream(dict, rec.stream.data, resolve) : null
    if (decoded && decoded.length) out.push(decoded)
  }
  collect(pageDict.get('Contents'))
  if (!out.length) return null
  return Buffer.concat(out)
}

// ---------------- 字体 ----------------

const WIN_ANSI_EXTRA = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
}

function winAnsiTable() {
  const table = new Array(256).fill('')
  for (let i = 0x20; i < 0x7f; i++) table[i] = String.fromCharCode(i)
  for (let i = 0xa0; i < 0x100; i++) table[i] = String.fromCharCode(i)
  for (const [k, v] of Object.entries(WIN_ANSI_EXTRA)) table[Number(k)] = v
  table[0x09] = ' '
  table[0x0a] = ' '
  table[0x0d] = ''
  return table
}

const MAC_ROMAN_UPPER =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\uF8FFÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ'

function macRomanTable() {
  const table = winAnsiTable()
  for (let i = 0; i < 128; i++) table[0x80 + i] = MAC_ROMAN_UPPER[i] || ''
  return table
}

// 常见字形名 → Unicode（Latin 为主，够读小说里的标点和字母）
const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%',
  ampersand: '&', quotesingle: "'", parenleft: '(', parenright: ')', asterisk: '*',
  plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/', zero: '0', one: '1',
  two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@',
  bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_',
  grave: '`', braceleft: '{', bar: '|', braceright: '}', asciitilde: '~',
  quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”',
  quotesinglbase: '‚', quotedblbase: '„', guillemotleft: '«', guillemotright: '»',
  endash: '–', emdash: '—', bullet: '•', ellipsis: '…', dagger: '†', daggerdbl: '‡',
  perthousand: '‰', section: '§', paragraph: '¶', periodcentered: '·', degree: '°',
  copyright: '©', registered: '®', trademark: '™', euro: '€', sterling: '£', yen: '¥',
  cent: '¢', currency: '¤', brokenbar: '¦', logicalnot: '¬', plusminus: '±',
  multiply: '×', divide: '÷', micro: 'µ', mu: 'µ', onehalf: '½', onequarter: '¼',
  threequarters: '¾', onesuperior: '¹', twosuperior: '²', threesuperior: '³',
  ordfeminine: 'ª', ordmasculine: 'º', nbspace: ' ', nonbreakingspace: ' ',
  fi: 'fi', fl: 'fl', ffi: 'ffi', ffl: 'ffl', germandbls: 'ß', ae: 'æ', AE: 'Æ',
  oe: 'œ', OE: 'Œ', oslash: 'ø', Oslash: 'Ø', aring: 'å', Aring: 'Å', questiondown: '¿',
  exclamdown: '¡', dotlessi: 'ı', circumflex: 'ˆ', tilde: '˜', breve: '˘', caron: 'ˇ',
  ring: '˚', ogonek: '˛', dotaccent: '˙', hungarumlaut: '˝', cedilla: '¸', macron: '¯',
  acute: '´', dieresis: '¨',
}

function glyphToUnicode(name) {
  const n = String(name || '')
  if (!n) return ''
  if (n.length === 1) return n
  if (GLYPHS[n] != null) return GLYPHS[n]
  const m = /^uni([0-9A-Fa-f]{4,6})$/.exec(n)
  if (m) return safeCodePoint(parseInt(m[1], 16))
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(n)
  if (u) return safeCodePoint(parseInt(u[1], 16))
  return ''
}

function safeCodePoint(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  if (code >= 0xd800 && code <= 0xdfff) return ''
  try {
    return String.fromCodePoint(code)
  } catch (error) {
    return ''
  }
}

function makeFontDecoder(fontDict, resolve, getObj) {
  const subtype = String(nameOfDict(fontDict, resolve, 'Subtype')).toLowerCase()
  const toUnicode = streamText(fontDict.get('ToUnicode'), getObj, resolve)
  const cmap = toUnicode ? parseCMap(toUnicode) : null
  const composite = subtype === 'type0'

  if (cmap && cmap.map.size) {
    const codeLen = cmap.codeLen || (composite ? 2 : 1)
    return makeCmapDecoder(cmap, codeLen)
  }

  if (composite) {
    // 没有 ToUnicode 的 CJK 复合字体：CID 不是 Unicode，抽出来是乱码，宁可不猜
    return {
      decode: (bytes) => ({ text: '', unknown: Math.max(1, Math.ceil(bytes.length / 2)) }),
      lossy: true,
    }
  }

  const table = simpleTable(fontDict, resolve)
  return {
    decode: (bytes) => {
      let text = ''
      let unknown = 0
      for (let i = 0; i < bytes.length; i++) {
        const ch = table[bytes.charCodeAt(i)]
        if (ch != null) text += ch
        else unknown++
      }
      return { text, unknown }
    },
  }
}

function nameOfDict(dict, resolve, key) {
  const v = resolve(dict.get(key))
  return v && v.t === 'name' ? v.v : ''
}

function streamText(val, getObj, resolve) {
  const rec = getObj(val)
  if (!rec || !rec.stream || !rec.stream.data) return ''
  const dict = rec.value && rec.value.t === 'dict' ? rec.value.v : null
  const decoded = dict ? decodeStream(dict, rec.stream.data, resolve) : rec.stream.data
  return decoded ? decoded.toString('latin1') : ''
}

function simpleTable(fontDict, resolve) {
  const encoding = resolve(fontDict.get('Encoding'))
  let table = winAnsiTable()
  if (encoding) {
    if (encoding.t === 'name') {
      if (/^mac/i.test(encoding.v)) table = macRomanTable()
    } else if (encoding.t === 'dict') {
      const base = resolve(encoding.v.get('BaseEncoding'))
      if (base && base.t === 'name' && /^mac/i.test(base.v)) table = macRomanTable()
      else table = winAnsiTable().slice()
      const diffs = resolve(encoding.v.get('Differences'))
      if (diffs && diffs.t === 'arr') {
        let code = 0
        for (const item of diffs.v) {
          const v = resolve(item)
          if (v && v.t === 'num') code = v.v
          else if (v && v.t === 'name') {
            const u = glyphToUnicode(v.v)
            if (code >= 0 && code < 256) table[code] = u
            code++
          }
        }
      }
    }
  }
  return table
}

// ---------------- ToUnicode CMap ----------------

function utf16FromHex(hex) {
  let h = hex
  if (h.length % 4) h = h.padStart(h.length + (4 - (h.length % 4)), '0')
  let out = ''
  for (let i = 0; i + 4 <= h.length; i += 4) {
    const unit = parseInt(h.slice(i, i + 4), 16)
    if (unit === 0xffff) continue
    out += String.fromCharCode(unit)
  }
  return out
}

function hexToUnits(hex) {
  let h = hex
  if (h.length % 4) h = h.padStart(h.length + (4 - (h.length % 4)), '0')
  const out = []
  for (let i = 0; i + 4 <= h.length; i += 4) out.push(parseInt(h.slice(i, i + 4), 16))
  return out
}

export function parseCMap(src) {
  const map = new Map()
  let codeLen = 0
  const noteLen = (hex) => {
    const bytes = Math.ceil(hex.length / 2)
    if (bytes === 1 || bytes === 2) codeLen = Math.max(codeLen, bytes)
  }
  for (const block of String(src || '').match(/beginbfchar([\s\S]*?)endbfchar/gi) || []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      noteLen(m[1])
      map.set(m[1].toLowerCase(), utf16FromHex(m[2]))
    }
  }
  for (const block of String(src || '').match(/beginbfrange([\s\S]*?)endbfrange/gi) || []) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g
    for (const m of block.matchAll(re)) {
      noteLen(m[1])
      const lo = parseInt(m[1], 16)
      const hi = parseInt(m[2], 16)
      const width = m[1].length
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue
      const count = Math.min(hi - lo, 0x10000)
      if (m[3]) {
        const units = hexToUnits(m[3])
        for (let i = 0; i <= count; i++) {
          const copy = units.slice()
          if (copy.length) copy[copy.length - 1] += i
          map.set((lo + i).toString(16).padStart(width, '0').toLowerCase(), unitsToString(copy))
        }
      } else if (m[4]) {
        const items = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1])
        for (let i = 0; i <= Math.min(count, items.length - 1); i++) {
          map.set((lo + i).toString(16).padStart(width, '0').toLowerCase(), utf16FromHex(items[i]))
        }
      }
    }
  }
  return { map, codeLen }
}

function unitsToString(units) {
  let out = ''
  for (const u of units) out += String.fromCharCode(u)
  return out
}

function makeCmapDecoder(cmap, codeLen) {
  return {
    decode: (bytes) => {
      let text = ''
      let unknown = 0
      const step = codeLen
      for (let i = 0; i + step <= bytes.length; i += step) {
        const key = toHex(bytes, i, step)
        let v = cmap.map.get(key)
        if (v == null && step === 2) {
          // 有些字体单字节 / 双字节混着写
          v = cmap.map.get(toHex(bytes, i, 1))
          if (v != null) i -= 1
        }
        if (v != null) text += v
        else unknown++
      }
      return { text, unknown }
    },
  }
}

function toHex(bytes, start, len) {
  let out = ''
  for (let i = start; i < start + len && i < bytes.length; i++) {
    out += bytes.charCodeAt(i).toString(16).padStart(2, '0')
  }
  return out
}

// ---------------- 内容流 ----------------

function extractText(data, fonts) {
  if (!data || !data.length) return { text: '', unknown: 0 }
  const s = data.toString('latin1')
  let i = 0
  const out = []
  let unknown = 0

  let font = null
  let fontSize = 12
  let leading = 0
  let lineX = 0
  let lineY = 0
  let x = 0
  let y = 0
  let lastX = 0
  let lastY = 0
  let anyText = false

  const operands = []

  const newline = () => {
    if (out.length && out[out.length - 1] !== '\n') out.push('\n')
  }

  const show = (str) => {
    if (!str) return
    const dec = font || null
    let text = ''
    if (dec) {
      const r = dec.decode(str)
      text = r.text
      unknown += r.unknown
    } else {
      // 没指定字体：当单字节 Latin 处理
      for (let k = 0; k < str.length; k++) {
        const code = str.charCodeAt(k)
        text += code >= 0x20 && code < 0x7f ? str[k] : ''
      }
    }
    if (!text) return
    if (anyText) {
      if (Math.abs(y - lastY) > Math.max(1, fontSize * 0.45)) newline()
      else if (x - lastX > fontSize * 1.8 && !/[\s]$/.test(out[out.length - 1])) out.push(' ')
    }
    // 去掉行首多余空格
    if (!out.length || out[out.length - 1] === '\n') text = text.replace(/^[ \t]+/, '')
    if (!text) return
    out.push(text)
    anyText = true
    lastX = x + estimateWidth(text, fontSize)
    lastY = y
  }

  const moveLine = (tx, ty) => {
    // 只处理常见情况（无旋转 / 缩放）：行矩阵平移
    lineX += tx
    lineY += ty
    x = lineX
    y = lineY
  }

  while (i < s.length) {
    const c = s[i]
    const code = s.charCodeAt(i)
    if (isWs(code)) { i++; continue }
    if (c === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue }

    if (c === '(') {
      const cur = new Cursor(s, i)
      const v = parseLiteralString(cur)
      operands.push({ t: 'str', v: v.v })
      i = cur.i
      continue
    }
    if (c === '<') {
      if (s[i + 1] === '<') {
        // 内联字典（BDC 的属性）：整段跳过
        const cur = new Cursor(s, i)
        parseValue(cur)
        i = cur.i
        continue
      }
      const cur = new Cursor(s, i)
      const v = parseHexString(cur)
      operands.push({ t: 'str', v: v.v })
      i = cur.i
      continue
    }
    if (c === '[') { operands.push({ t: '[', v: [] }); i++; continue }
    if (c === ']') {
      const arr = []
      while (operands.length && operands[operands.length - 1].t !== '[') arr.unshift(operands.pop())
      if (operands.length) operands.pop()
      operands.push({ t: 'arr', v: arr })
      i++
      continue
    }
    if (c === '/') {
      const cur = new Cursor(s, i)
      operands.push(parseValue(cur))
      i = cur.i
      continue
    }
    if (isDigit(code) || c === '-' || c === '+' || c === '.') {
      const m = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i, i + 40))
      if (m) {
        operands.push({ t: 'num', v: Number(m[0]) })
        i += m[0].length
        continue
      }
    }

    const word = /^[^\s<>[\]{}/()%]+/.exec(s.slice(i, i + 30))
    if (!word) { i++; continue }
    const op = word[0]
    i += op.length

    if (op === 'BT') {
      lineX = 0; lineY = 0; x = 0; y = 0
    } else if (op === 'ET') {
      // ET 只是文字块结束，不代表换行：换行交给 y 坐标判断
    } else if (op === 'Tf') {
      const nameTok = operands.length >= 2 ? operands[operands.length - 2] : null
      const sizeTok = operands.length >= 1 ? operands[operands.length - 1] : null
      if (nameTok && nameTok.t === 'name') font = fonts.get(nameTok.v) || null
      if (sizeTok && sizeTok.t === 'num') fontSize = Math.abs(sizeTok.v) || fontSize
    } else if (op === 'Tm') {
      const v = operands.slice(-6)
      if (v.length === 6 && v.every((t) => t.t === 'num')) {
        lineX = v[4].v
        lineY = v[5].v
        x = lineX
        y = lineY
      }
    } else if (op === 'Td' || op === 'TD') {
      const v = operands.slice(-2)
      if (v.length === 2 && v.every((t) => t.t === 'num')) {
        moveLine(v[0].v, v[1].v)
        if (op === 'TD') leading = -v[1].v
      }
    } else if (op === 'TL') {
      const t = operands[operands.length - 1]
      if (t && t.t === 'num') leading = t.v
    } else if (op === 'T*') {
      moveLine(0, -leading)
    } else if (op === 'Tj') {
      const t = operands[operands.length - 1]
      if (t && t.t === 'str') show(t.v)
    } else if (op === 'TJ') {
      const arr = operands[operands.length - 1]
      if (arr && arr.t === 'arr') {
        for (const item of arr.v) {
          if (item.t === 'str') show(item.v)
          else if (item.t === 'num' && item.v <= -120) {
            const last = out[out.length - 1] || ''
            if (last && !/[\s]$/.test(last)) out.push(' ')
          }
        }
      }
    } else if (op === "'") {
      moveLine(0, -leading)
      const t = operands[operands.length - 1]
      if (t && t.t === 'str') show(t.v)
    } else if (op === '"') {
      moveLine(0, -leading)
      const t = operands[operands.length - 1]
      if (t && t.t === 'str') show(t.v)
    } else if (op === 'BI') {
      // 内联图片：跳到 EI
      const end = s.indexOf('EI', i)
      i = end < 0 ? s.length : end + 2
    } else if (op === 'Do') {
      // 画图片 / 表单，没文字
    } else if (op === 'Tz' || op === 'Tc' || op === 'Tw') {
      // 字距 / 缩放：忽略
    }
    operands.length = 0
  }

  return { text: out.join(''), unknown }
}

function estimateWidth(text, fontSize) {
  let em = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    em += code >= 0x2e80 && code <= 0x9fff ? 1 : code >= 0x3000 && code <= 0x30ff ? 1 : 0.5
  }
  return em * fontSize
}

function tidy(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.;:!?，。；：！？])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// 行尾是这些标点，说明一句话 / 一段说完，不该和下一行拼起来
const LINE_END = /[。！？…；：”’」』】）》)\]~～—!?;:]$/
// 这些开头是新段落 / 新章节 / 小标题
const LINE_HEAD = /^(?:第[一二三四五六七八九十百千零两0-9]+[章节卷回部集篇]|[一二三四五六七八九十]+[、.．]|[(（]?[0-9]{1,3}[)）、.．]|序章|序言|楔子|引子|前言|后记|尾声|番外|实验[一二三四五六七八九十0-9]*[：:、.．]?|小结|总结|附录|参考文献|致谢|目录|Chapter\b|CHAPTER\b)/
// 短标签行（「学生姓名：」「学号：」）后面是另一栏，不拼
const LABEL_LINE = /^[^。！？，,]{0,12}[：:]$/

/**
 * PDF 的每一行都是排版折行，不是段落。把折行拼回段落：
 * 上一行没有句末标点、也不太短，就把下一行接上去。英文之间补空格，中文直接接。
 */
export function reflow(text) {
  const lines = String(text || '').split('\n')
  const out = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    const prev = out.length ? out[out.length - 1] : ''
    const canJoin =
      prev &&
      prev !== '' &&
      !LINE_END.test(prev) &&
      !LABEL_LINE.test(prev) &&
      !LINE_HEAD.test(line) &&
      !LINE_HEAD.test(prev) &&
      prev.length >= 12
    if (canJoin) {
      if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(line)) out[out.length - 1] = prev.slice(0, -1) + line
      else {
        const space = /[A-Za-z0-9)\]%]$/.test(prev) && /^[A-Za-z0-9([]/.test(line) ? ' ' : ''
        out[out.length - 1] = prev + space + line
      }
      continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 给「看小说」用：PDF 字节 → 正文。读不出来时抛错，错误信息能直接给人看。 */
export function pdfToText(buf) {
  const parsed = parsePdf(buf)
  const text = reflow(parsed.text)
  const plain = text.replace(/\s+/g, '')
  const perPage = parsed.pages ? plain.length / parsed.pages : plain.length
  if (!plain.length || perPage < 5) {
    // 确实读到过文字、但一个字都没认出来：字体没带 ToUnicode（不是扫描件）
    if (parsed.unknownChars > 0) {
      throw new Error('这本 PDF 的字体没有带文字映射（常见于特殊字体排版的 PDF），抽出来是乱码，建议转成 txt / epub 再给我')
    }
    throw new Error('这本 PDF 没有文字层（扫描版 / 图片版），要先用 OCR 转成文字才能读')
  }
  if (plain.length > 20 && parsed.unknownChars > plain.length * 0.3) {
    throw new Error('这本 PDF 的字体没有带文字映射（常见于特殊字体排版的 PDF），抽出来是乱码，建议转成 txt / epub 再给我')
  }
  return { text, pages: parsed.pages, format: 'pdf' }
}
