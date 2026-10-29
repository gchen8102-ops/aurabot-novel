// 书架数据：一本本书、人物卡、现在学的是谁。数据都在 api.dataDir() 里，插件升级不动。
//
//   library.json          书架索引 + 每本书的人物卡 + 现在学谁
//   books/<id>.txt        正文（导入时复制一份，原文件删了也能重读）
//   notes/<id>.json       分段阅读笔记（读到一半停下来，下次接着读）
//   books/                主人往里丢 txt 的文件夹（自动收书）

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync,
  statSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const VERSION = 1

const emptyLibrary = () => ({ version: VERSION, updatedAt: Date.now(), books: {}, active: null })

/** 归一化书名 / 人名，用来做模糊匹配。 */
export function normKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s《》〈〉「」『』【】\[\]()（）\-_.,，。:：;；!！?？'"“”‘’·~～]/g, '')
}

export function createStore(api) {
  const root = api.dataDir()
  const paths = {
    root,
    texts: join(root, 'books'),
    notes: join(root, 'notes'),
    index: join(root, 'index'),
    shelf: join(root, 'shelf'),
    file: join(root, 'library.json'),
  }
  for (const d of [paths.texts, paths.notes, paths.index, paths.shelf]) mkdirSync(d, { recursive: true })

  let cache = null
  let cacheAt = 0
  let cacheStamp = ''

  function load(force = false) {
    let stamp = ''
    try {
      const st = statSync(paths.file)
      stamp = `${st.mtimeMs}:${st.size}`
    } catch (error) {
      if (!cache) cache = emptyLibrary()
      return cache
    }
    if (!force && cache && stamp === cacheStamp && Date.now() - cacheAt < 1000) return cache
    try {
      const parsed = JSON.parse(readFileSync(paths.file, 'utf8'))
      cache = normalizeLibrary(parsed)
    } catch (error) {
      // 文件坏了：留一份备份，从空书架开始，别让她整个模块起不来
      try {
        api.log.warn(`书架文件读不出来（${error.message}），备份成 library.broken.json`)
        renameSync(paths.file, join(root, 'library.broken.json'))
      } catch (e) {}
      cache = emptyLibrary()
    }
    cacheAt = Date.now()
    cacheStamp = stamp
    return cache
  }

  function normalizeLibrary(lib) {
    const out = emptyLibrary()
    if (!lib || typeof lib !== 'object') return out
    out.updatedAt = Number(lib.updatedAt) || Date.now()
    if (lib.books && typeof lib.books === 'object') {
      for (const [id, b] of Object.entries(lib.books)) {
        if (!b || typeof b !== 'object') continue
        out.books[id] = {
          id: String(b.id || id),
          title: String(b.title || id),
          hash: String(b.hash || ''),
          chars: Number(b.chars) || 0,
          format: String(b.format || ''),
          pages: Number(b.pages) || 0,
          pdfPath: String(b.pdfPath || ''),
          pdfSize: Number(b.pdfSize) || 0,
          source: String(b.source || ''),
          sourceName: String(b.sourceName || ''),
          addedAt: Number(b.addedAt) || Date.now(),
          updatedAt: Number(b.updatedAt) || Date.now(),
          status: String(b.status || 'new'),
          error: String(b.error || ''),
          progress: {
            done: Number(b.progress?.done) || 0,
            total: Number(b.progress?.total) || 0,
            sampled: Boolean(b.progress?.sampled),
          },
          profile: b.profile && typeof b.profile === 'object' ? b.profile : null,
        }
      }
    }
    if (lib.active && lib.active.bookId && out.books[lib.active.bookId]) {
      out.active = {
        bookId: String(lib.active.bookId),
        name: String(lib.active.name || ''),
        at: Number(lib.active.at) || Date.now(),
      }
    }
    return out
  }

  function save() {
    const lib = cache || emptyLibrary()
    lib.updatedAt = Date.now()
    const data = JSON.stringify(lib, null, 2)
    const tmp = paths.file + '.tmp'
    try {
      writeFileSync(tmp, data, 'utf8')
      renameSync(tmp, paths.file)
    } catch (error) {
      try {
        writeFileSync(paths.file, data, 'utf8')
        rmSync(tmp, { force: true })
      } catch (e) {
        api.log.warn(`书架保存失败：${e.message}`)
      }
    }
    try {
      const st = statSync(paths.file)
      cacheStamp = `${st.mtimeMs}:${st.size}`
      cacheAt = Date.now()
    } catch (error) {}
    return lib
  }

  function library(force = false) {
    return load(force)
  }

  function books() {
    return Object.values(load().books).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  function byId(id) {
    return load().books[String(id || '')] || null
  }

  function find(query) {
    const q = normKey(query)
    if (!q) return null
    const list = books()
    let hit = list.find((b) => normKey(b.title) === q || normKey(b.id) === q)
    if (hit) return hit
    hit = list.find((b) => normKey(b.title).includes(q) || q.includes(normKey(b.title)))
    if (hit) return hit
    return list.find((b) => normKey(b.title).startsWith(q)) || null
  }

  function addBook(book) {
    const lib = load(true)
    lib.books[book.id] = book
    save()
    return book
  }

  function updateBook(id, patch) {
    const lib = load(true)
    const cur = lib.books[id]
    if (!cur) return null
    const next = { ...cur, ...patch, id: cur.id, updatedAt: Date.now() }
    lib.books[id] = next
    save()
    return next
  }

  function removeBook(id) {
    const lib = load(true)
    if (!lib.books[id]) return false
    const title = lib.books[id].title
    delete lib.books[id]
    if (lib.active?.bookId === id) lib.active = null
    save()
    for (const file of [
      join(paths.texts, id + '.txt'),
      join(paths.texts, id + '.pdf'),
      join(paths.notes, id + '.json'),
      join(paths.index, id + '.json'),
    ]) {
      try { rmSync(file, { force: true }) } catch (error) {}
    }
    return { title }
  }

  function active() {
    const lib = load()
    if (!lib.active) return null
    const book = lib.books[lib.active.bookId]
    if (!book) return null
    return lib.active
  }

  function setActive(active) {
    const lib = load(true)
    lib.active = active ? { bookId: String(active.bookId), name: String(active.name || ''), at: Date.now() } : null
    save()
    return lib.active
  }

  function textOf(book) {
    try {
      return readFileSync(join(paths.texts, book.id + '.txt'), 'utf8')
    } catch (error) {
      return ''
    }
  }

  function saveText(id, text) {
    writeFileSync(join(paths.texts, id + '.txt'), text, 'utf8')
  }

  // ---- 漫画：原 PDF + 页索引 ----
  // 从书架文件夹 / 本地路径进来的书只记原路径，不复制 70MB 的大文件；
  // 从 QQ / 网址收的没有稳定路径，才复制到 books/<id>.pdf。

  function pdfPathOf(book) {
    if (!book) return ''
    if (book.pdfPath) return book.pdfPath
    const local = join(paths.texts, book.id + '.pdf')
    return existsSync(local) ? local : ''
  }

  function savePdf(id, buf) {
    const file = join(paths.texts, id + '.pdf')
    writeFileSync(file, buf)
    return file
  }

  function indexPath(id) {
    return join(paths.index, id + '.json')
  }

  function indexOf(id) {
    try {
      const j = JSON.parse(readFileSync(indexPath(id), 'utf8'))
      return j && typeof j === 'object' ? j : null
    } catch (error) {
      return null
    }
  }

  function saveIndex(id, data) {
    const file = indexPath(id)
    const tmp = file + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(data), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      try { writeFileSync(file, JSON.stringify(data), 'utf8') } catch (e) {}
    }
  }

  function notesOf(id) {
    try {
      const j = JSON.parse(readFileSync(join(paths.notes, id + '.json'), 'utf8'))
      if (!j || typeof j !== 'object') return null
      return j
    } catch (error) {
      return null
    }
  }

  function saveNotes(id, notes) {
    notes.updatedAt = Date.now()
    const file = join(paths.notes, id + '.json')
    const tmp = file + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(notes), 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      try { writeFileSync(file, JSON.stringify(notes), 'utf8') } catch (e) {}
    }
  }

  function newId(title) {
    const base = 'b-' + requireSlug(title)
    let id = base
    let n = 2
    while (existsSync(join(paths.texts, id + '.txt')) || existsSync(join(paths.texts, id + '.pdf')) || byId(id)) id = `${base}-${n++}`
    return id
  }

  function hash(text) {
    return createHash('sha1').update(String(text)).digest('hex')
  }

  function shelfFiles() {
    try {
      return readdirSync(paths.shelf)
        .filter((n) => /\.(txt|md|text|docx|epub|pdf)$/i.test(n))
        .map((name) => {
          try {
            const st = statSync(join(paths.shelf, name))
            return { name, size: st.size, mtimeMs: st.mtimeMs, path: join(paths.shelf, name) }
          } catch (error) {
            return null
          }
        })
        .filter(Boolean)
    } catch (error) {
      return []
    }
  }

  return {
    paths,
    library,
    save,
    books,
    byId,
    find,
    addBook,
    updateBook,
    removeBook,
    active,
    setActive,
    textOf,
    saveText,
    pdfPathOf,
    savePdf,
    indexOf,
    saveIndex,
    notesOf,
    saveNotes,
    newId,
    hash,
    shelfFiles,
  }
}

// 和 text.mjs 的 slug 一样，但这里不想为了一个函数多引一个模块（也避免循环依赖）
function requireSlug(text) {
  const s = String(text || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
  return s || 'book'
}
