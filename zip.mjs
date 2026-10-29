// 只读 zip：docx 和 epub 都是 zip。只认 stored / deflate —— 小说用不到别的压缩方式。
// 纯函数，不碰文件系统，方便单独测。

import { inflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOC = 0x07064b50

/** 是不是 zip 文件（docx / epub 都是）。 */
export function looksLikeZip(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7)
}

function findEocd(b) {
  const floor = Math.max(0, b.length - 0x10000 - 22)
  for (let i = b.length - 22; i >= floor; i--) {
    if (b.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

function readZip64End(b, eocd) {
  // zip64：EOCD 前面有 locator，locator 里是 EOCD64 记录的偏移
  if (eocd < 20) return null
  if (b.readUInt32LE(eocd - 20) !== SIG_EOCD64_LOC) return null
  const off = Number(b.readBigUInt64LE(eocd - 20 + 8))
  if (!Number.isFinite(off) || off + 56 > b.length) return null
  if (b.readUInt32LE(off) !== SIG_EOCD64) return null
  return {
    count: Number(b.readBigUInt64LE(off + 32)),
    cdOffset: Number(b.readBigUInt64LE(off + 48)),
  }
}

/** 从 extra 里把 zip64 扩展字段挑出来（本地头 / 中央目录都用）。 */
function zip64Sizes(extra) {
  const out = {}
  let p = 0
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p)
    const len = extra.readUInt16LE(p + 2)
    if (p + 4 + len > extra.length) break
    if (id === 0x0001) {
      let q = p + 4
      const take = () => {
        if (q + 8 > p + 4 + len) return null
        const v = Number(extra.readBigUInt64LE(q))
        q += 8
        return v
      }
      out.uncompSize = take()
      out.compSize = take()
      out.localOff = take()
    }
    p += 4 + len
  }
  return out
}

function decodeEntry(b, entry) {
  const { method, compSize, localOff } = entry
  if (localOff + 30 > b.length || b.readUInt32LE(localOff) !== SIG_LOCAL) return null
  const nameLen = b.readUInt16LE(localOff + 26)
  const extraLen = b.readUInt16LE(localOff + 28)
  const start = localOff + 30 + nameLen + extraLen
  let size = compSize
  if (!size) {
    // 有的写入器在中央目录里写 0，真正的数据用「到下一个本地头 / endstream」来定界
    const next = b.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), start)
    size = (next > start ? next : b.length) - start
  }
  const data = b.subarray(start, Math.min(b.length, start + size))
  if (method === 0) return data
  if (method === 8) {
    try {
      return inflateRawSync(data)
    } catch (error) {
      // 多截了尾巴（compSize 不准）时，容忍尾部垃圾再试一次
      try {
        return inflateRawSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH */ })
      } catch (e) {
        return null
      }
    }
  }
  return null
}

/**
 * 打开一个 zip。
 * 返回 { names(), entries, has(name), read(name) → Buffer|null, readText(name) → string }；
 * 不是 zip 返回 null。
 */
export function openZip(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input || [])
  if (!looksLikeZip(b)) return null
  const eocd = findEocd(b)
  if (eocd < 0) return null
  let count = b.readUInt16LE(eocd + 10)
  let cdOffset = b.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const z = readZip64End(b, eocd)
    if (z) {
      count = z.count
      cdOffset = z.cdOffset
    }
  }
  const entries = new Map()
  let p = cdOffset
  for (let i = 0; i < count && p + 46 <= b.length; i++) {
    if (b.readUInt32LE(p) !== SIG_CENTRAL) break
    const flags = b.readUInt16LE(p + 8)
    const method = b.readUInt16LE(p + 10)
    let compSize = b.readUInt32LE(p + 20)
    let uncompSize = b.readUInt32LE(p + 24)
    const nameLen = b.readUInt16LE(p + 28)
    const extraLen = b.readUInt16LE(p + 30)
    const commentLen = b.readUInt16LE(p + 32)
    let localOff = b.readUInt32LE(p + 42)
    const name = b.toString('utf8', p + 46, p + 46 + nameLen)
    const extra = b.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen)
    if (compSize === 0xffffffff || localOff === 0xffffffff || uncompSize === 0xffffffff) {
      const z = zip64Sizes(extra)
      if (Number.isFinite(z.compSize)) compSize = z.compSize
      if (Number.isFinite(z.localOff)) localOff = z.localOff
      if (Number.isFinite(z.uncompSize)) uncompSize = z.uncompSize
    }
    if (name && !name.endsWith('/')) {
      entries.set(name, { name, method, compSize, uncompSize, localOff, flags })
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  if (!entries.size) return null

  const cache = new Map()
  const read = (name) => {
    const key = String(name)
    if (cache.has(key)) return cache.get(key)
    const entry = entries.get(key)
    const out = entry ? decodeEntry(b, entry) : null
    cache.set(key, out)
    return out
  }
  const readText = (name) => {
    const buf = read(name)
    return buf ? buf.toString('utf8') : ''
  }

  return {
    buffer: b,
    entries,
    names: () => [...entries.keys()],
    has: (name) => entries.has(String(name)),
    read,
    readText,
  }
}
