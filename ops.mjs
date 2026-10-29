// 「看小说」的具体操作：收书、读书、学角色、查询、命令文字。
// index.mjs 只负责把它接到插件上。

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { createStore, normKey } from './store.mjs'
import {
  documentText, cleanText, splitChunks, pickIndices,
  titleFromFilename, titleFromUrl, cut, charsLabel,
} from './text.mjs'
import { isPdf } from './pdf.mjs'
import {
  scanComicPdf, looksLikeComic, readComicPage, readComicRoster, analyzeComicPages,
} from './comic.mjs'
import { analyzeChunk, synthesize, mergeLocal, withTimeout } from './learn.mjs'
import {
  personaBlock, contextLine, ruleLine, characterCard, normalizeStrength,
} from './style.mjs'

const clampNum = (v, min, max, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const FILE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
const mbLabel = (n) => `${(Number(n || 0) / 1048576).toFixed(1)}MB`

/**
 * 从 QQ 文件消息里把文件下下来。消息段一般自带直链；没有就问网关要（私聊 / 群文件接口不一样）。
 *
 * 两个坑（2026-10-29 实测，73MB 的 PDF）：
 *  1) 直链是 QQ 的离线文件通道，不带 Range 时服务器要准备好整个文件才回头，25 秒都拿不到响应头；
 *     带上 `Range: bytes=0-` 立刻 206，所以下载一律带 Range。
 *  2) 通道本身很慢（约 60KB/s），70MB 要下 20 分钟，旧的 60 秒超时必然失败。
 *     这里改成流式下载：总预算可配（默认 8 分钟）、按「单本最大 MB」边下边截断、超时能说清楚下到哪了。
 */
export async function fetchQQFile(api, msg, data, { maxBytes = 0, timeoutMs = 8 * 60_000, onProgress } = {}) {
  const fileId = data.file_id || data.id || data.file_uuid || data.file
  const fileHash = String(data.file_hash || data.fileHash || '')
  const sizeHint = Number(data.file_size || data.size || 0)
  const problems = []
  const budget = Math.max(20_000, Number(timeoutMs) || 0)
  const deadline = Date.now() + budget
  const tooBig = (n) => {
    const e = new Error(`文件 ${mbLabel(n)}，超过单本上限 ${Math.round(maxBytes / 1048576)}MB`)
    e.code = 'TOO_BIG'
    return e
  }
  // 段里就写着大小：超过上限就别下了，省得等半天再被拒
  if (maxBytes && sizeHint > maxBytes) throw tooBig(sizeHint)

  async function download(url) {
    const left = deadline - Date.now()
    if (left <= 1500) { problems.push('下载超时'); return null }
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, left)
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { range: 'bytes=0-', 'user-agent': FILE_UA, accept: '*/*' },
      })
      if (!res.ok) { problems.push(`HTTP ${res.status}`); return null }
      if (!res.body) return null
      const total = Number(res.headers.get('content-length') || 0) || sizeHint
      if (maxBytes && total > maxBytes) throw tooBig(total)
      const chunks = []
      let done = 0
      for await (const part of res.body) {
        done += part.length
        if (maxBytes && done > maxBytes) throw tooBig(done)
        chunks.push(Buffer.from(part))
        try { onProgress?.(done, total) } catch (error) {}
      }
      return done ? Buffer.concat(chunks) : null
    } catch (error) {
      if (error?.code === 'TOO_BIG') throw error
      problems.push(timedOut ? `下载超时（${Math.round(budget / 1000)} 秒，通道慢）` : (error?.message || String(error)))
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  // 1) 消息段里就带着下载地址（SnowLuma 收私聊 / 群文件时都有）
  for (const raw of [data.url, data.file_url]) {
    if (!raw || !/^https?:\/\//i.test(String(raw))) continue
    const buf = await download(String(raw))
    if (buf) return buf
  }

  // 2) 问网关要地址：私聊用 get_private_file_url（file_hash 要原样带上），群文件用 get_group_file_url
  const attempts = []
  if (msg.kind === 'group') {
    attempts.push(['get_group_file_url', {
      group_id: Number(msg.groupId),
      file_id: fileId,
      busid: Number(data.busid || data.bus_id || 0),
    }])
  } else {
    attempts.push(['get_private_file_url', {
      user_id: Number(msg.userId) || undefined,
      file_id: fileId,
      file_hash: fileHash,
    }])
  }
  // 3) 最后才是老接口 get_file —— 它只认图片 / 语音缓存，普通文件都会报 file_id not found
  attempts.push(['get_file', { file_id: fileId }])

  for (const [action, params] of attempts) {
    if (!params.file_id && !params.file_hash) continue
    try {
      const r = await api.onebot(action, params, { timeoutMs: 20000 })
      if (r && r.retcode && r.retcode !== 0) {
        problems.push(action + '：' + (r.wording || r.message || 'retcode ' + r.retcode))
        continue
      }
      const d = r?.data && typeof r.data === 'object' ? r.data : r || {}
      const url = d.url || r?.url
      if (url) {
        const buf = await download(String(url))
        if (buf) return buf
      }
      const b64 = d.base64 || r?.base64
      if (b64) return Buffer.from(String(b64).replace(/^base64:\/\//, ''), 'base64')
      const local = d.file || r?.file
      if (local && typeof local === 'string') {
        if (/^base64:/.test(local)) return Buffer.from(local.slice(7), 'base64')
        if (existsSync(local)) return readFileSync(local)
      }
    } catch (error) {
      if (error?.code === 'TOO_BIG') throw error
      problems.push(action + '：' + error.message)
    }
  }

  const uniq = [...new Set(problems.filter(Boolean))]
  throw new Error(uniq.length ? uniq.join('；') : 'QQ 没给出文件下载地址')
}

export function createOps({ api, store = createStore(api) }) {
  let disposed = false
  let reading = null
  const log = api.log

  const settings = () => api.settings()
  const enabled = () => settings().enabled !== false
  const strength = () => normalizeStrength(settings().strength)
  const maxBytes = () => clampNum(settings().maxFileMB, 1, 200, 20) * 1024 * 1024
  const downloadBudgetMs = () => clampNum(settings().downloadTimeoutSec, 60, 1800, 480) * 1000

  // 上一次模块重新加载时可能正读到一半：没有进行中的任务，就标成「读了一半」，别一直显示在读
  try {
    for (const b of store.books()) {
      if (b.status === 'reading') store.updateBook(b.id, { status: 'paused' })
    }
  } catch (error) {}

  // ---------- 书架 ----------

  function activeStyle() {
    if (!enabled()) return null
    const a = store.active()
    if (!a) return null
    const book = store.byId(a.bookId)
    const character = (book?.profile?.characters || []).find((c) => c.name === a.name)
    if (!book || !character) return null
    return { book, character }
  }

  function hasBooks() {
    return store.books().length > 0
  }

  function personaBlockText() {
    const s = activeStyle()
    if (!s) return ''
    return personaBlock({ bookTitle: s.book.title, character: s.character, strength: strength() })
  }

  function contextText() {
    const s = activeStyle()
    if (s) return contextLine({ bookTitle: s.book.title, character: s.character })
    if (reading) return `（你正在${reading.kind === 'comic' ? '看漫画' : '读书'}《${reading.title}》，还没${reading.kind === 'comic' ? '看完' : '读完'}；别人问起可以聊两句，但别编后面的情节。）`
    return ''
  }

  function ruleLineText(kind) {
    const s = activeStyle()
    if (s) return ruleLine({ bookTitle: s.book.title, character: s.character, kind })
    if (hasBooks()) return '你书架上有书：可以用 novel_shelf 看有哪些、读到哪了；用 novel_recap 查读过书的情节和人物。别人问起还没读的书，别编内容。'
    return ''
  }

  // ---------- 导入 ----------

  function importBuffer(buf, { name = '', title = '', source = '', keepPath = '' } = {}) {
    if (!buf || !buf.length) return { ok: false, message: '这个文件是空的' }
    const limit = maxBytes()
    if (buf.length > limit) {
      return { ok: false, message: `文件太大了（${(buf.length / 1048576).toFixed(1)}MB），上限 ${Math.round(limit / 1048576)}MB，可以在设置里改「单本最大 MB」` }
    }
    // 正文可能是 txt / docx / epub / pdf：按格式自动拆
    const parsed = documentText(buf, name)
    let text = cleanText(parsed.text || '')
    // 没有文字层、一页一张图的 PDF（漫画 / 扫描书）：不当坏文件，收成漫画，让她一页页看
    if (text.length < 200 && isPdf(buf)) {
      const comic = tryImportComic(buf, { name, title, source, keepPath })
      if (comic) return comic
    }
    if (text.length < 200) {
      if (parsed.error) return { ok: false, message: parsed.error }
      const hint = parsed.kind === 'pdf' || parsed.kind === 'epub'
        ? '——这个 PDF / EPUB 里好像没有文字（扫描件、漫画图片那种抽不出来）'
        : '——可能不是 txt / docx / epub / pdf 小说，或者编码不对'
      return { ok: false, message: `没读到多少正文（少于 200 字）${hint}` }
    }

    const hash = store.hash(text)
    const dup = store.books().find((b) => b.hash === hash)
    if (dup) return { ok: true, duplicate: true, book: dup, message: `《${dup.title}》已经在书架上了` }

    let bookTitle = String(title || '').trim()
    if (!bookTitle && parsed.title) bookTitle = String(parsed.title).trim()
    if (!bookTitle) bookTitle = titleFromFilename(name) || '未命名小说'
    if (!String(title || '').trim() && /^\d{1,4}$/.test(bookTitle)) {
      // 文件名没信息量（1.txt / 新建文档.docx）：从正文第一行找书名
      bookTitle = titleFromBody(text) || bookTitle
    }
    const id = store.newId(bookTitle)
    store.saveText(id, text)
    const now = Date.now()
    const book = {
      id,
      title: bookTitle.slice(0, 80),
      hash,
      chars: text.length,
      format: parsed.kind || 'txt',
      pages: Number(parsed.pages) || 0,
      source,
      sourceName: name || '',
      addedAt: now,
      updatedAt: now,
      status: 'new',
      error: '',
      progress: { done: 0, total: 0, sampled: false },
      profile: null,
    }
    store.addBook(book)
    log.info(`收到书：《${book.title}》${formatLabel(book)}${charsLabel(text.length)}`)
    return { ok: true, book, message: `《${book.title}》（${formatLabel(book)}${charsLabel(text.length)}）已经放到书架上了` }
  }

  /** 图片 PDF 才收成漫画；普通文字 PDF 返回 null，让原来的流程报错。 */
  function tryImportComic(buf, { name, title, source, keepPath }) {
    let scan
    try {
      scan = scanComicPdf(buf)
    } catch (error) {
      return null
    }
    if (!looksLikeComic(scan)) return null
    const hash = createHash('sha1').update(buf).digest('hex')
    const dup = store.books().find((b) => b.hash === hash)
    if (dup) return { ok: true, duplicate: true, book: dup, message: `《${dup.title}》已经在书架上了` }

    let bookTitle = String(title || '').trim() || titleFromFilename(name) || '未命名漫画'
    const id = store.newId(bookTitle)
    // 路径 / 书架进来的只记原文件，不复制 70MB；QQ / 网址收的没有稳定路径，复制一份
    const pdfPath = keepPath || ''
    if (!pdfPath) store.savePdf(id, buf)
    store.saveIndex(id, {
      version: 1,
      pages: scan.pages,
      entries: scan.entries,
      hasFonts: scan.hasFonts,
      size: buf.length,
      at: Date.now(),
    })
    const now = Date.now()
    const book = {
      id,
      title: bookTitle.slice(0, 80),
      hash,
      chars: 0,
      format: 'comic',
      pages: scan.pages,
      pdfPath,
      pdfSize: buf.length,
      source,
      sourceName: name || '',
      addedAt: now,
      updatedAt: now,
      status: 'new',
      error: '',
      progress: { done: 0, total: scan.pages, sampled: false },
      profile: null,
    }
    store.addBook(book)
    log.info(`收到漫画：《${book.title}》${scan.pages} 页${scan.hasFonts ? '（带文字层）' : ''}`)
    const skipped = scan.skipped?.length ? `，有 ${scan.skipped.length} 页图片格式不认` : ''
    return {
      ok: true,
      book,
      message: `《${book.title}》（漫画 PDF · ${scan.pages} 页）已经放到书架上了${skipped}`,
    }
  }

  /** 「PDF · 12 页」这种格式标签，给书架和提示语用。 */
  function formatLabel(book) {
    const kind = String(book?.format || '').toLowerCase()
    const pages = Number(book?.pages) || 0
    if (kind === 'comic') return `漫画 · ${pages ? `${pages} 页` : '图片 PDF'} · `
    if (kind === 'pdf') return `PDF${pages ? ` · ${pages} 页` : ''} · `
    if (kind === 'epub') return 'EPUB · '
    if (kind === 'docx') return 'DOCX · '
    return ''
  }

  const isComic = (book) => String(book?.format || '').toLowerCase() === 'comic'

  /** 书架列表前面的小标签。 */
  function formatTag(book) {
    const kind = String(book?.format || '').toLowerCase()
    if (kind === 'comic') return '[漫画] '
    if (kind === 'pdf') return '[PDF] '
    if (kind === 'epub') return '[EPUB] '
    if (kind === 'docx') return '[DOCX] '
    return ''
  }

  // 文件名没信息量时，从正文开头猜书名：《书名》 / 「书名」 或者单独一行短句
  function titleFromBody(text) {
    const head = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || ''
    const wrapped = head.match(/^[《「『【]\s*(.{2,40}?)\s*[》」』】]/)
    if (wrapped) return wrapped[1].trim()
    if (head.length >= 2 && head.length <= 24 && !/[，,；;：:。！？!?]$/.test(head)) return head
    return ''
  }

  function importPath(path) {
    const p = String(path || '').trim().replace(/^["']|["']$/g, '')
    let full = p
    if (!existsSync(full)) full = join(store.paths.shelf, p)
    if (!existsSync(full)) return { ok: false, message: `找不到这个文件：${p}` }
    let st
    try {
      st = statSync(full)
    } catch (error) {
      return { ok: false, message: `读不了这个文件：${error.message}` }
    }
    if (!st.isFile()) return { ok: false, message: '这个路径不是文件' }
    if (st.size > maxBytes()) return { ok: false, message: `文件太大（${(st.size / 1048576).toFixed(1)}MB），上限 ${Math.round(maxBytes() / 1048576)}MB` }
    try {
      return importBuffer(readFileSync(full), { name: full.split(/[\\/]/).pop(), source: 'path', keepPath: resolve(full) })
    } catch (error) {
      return { ok: false, message: `读取失败：${error.message}` }
    }
  }

  async function importUrl(url) {
    const u = String(url || '').trim()
    if (!/^https?:\/\//i.test(u)) return { ok: false, message: '网址要以 http:// 或 https:// 开头' }
    let res
    try {
      res = await fetch(u, {
        signal: AbortSignal.timeout(30000),
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,text/plain,*/*',
        },
      })
    } catch (error) {
      return { ok: false, message: `下载失败：${error.message}` }
    }
    if (!res.ok) return { ok: false, message: `下载失败：HTTP ${res.status}` }
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > maxBytes()) return { ok: false, message: `网页太大了（${(len / 1048576).toFixed(1)}MB），换个 txt 直链吧` }
    let buf
    try {
      buf = Buffer.from(await res.arrayBuffer())
    } catch (error) {
      return { ok: false, message: `下载中断：${error.message}` }
    }
    const name = titleFromUrl(u)
    return importBuffer(buf, { name, title: name, source: 'url' })
  }

  // 书架文件夹里放着的 txt：自动收（同一个文件改过了也会重新收）
  const scanned = new Map()
  function scanShelf({ limit = 20 } = {}) {
    const results = []
    const pending = store.shelfFiles().filter((f) => scanned.get(f.name) !== `${f.size}:${Math.round(f.mtimeMs)}`)
    for (const f of pending.slice(0, limit)) {
      const key = `${f.size}:${Math.round(f.mtimeMs)}`
      if (scanned.get(f.name) === key) continue
      if (f.size > maxBytes()) {
        scanned.set(f.name, key)
        const line = `《${f.name}》有 ${mbLabel(f.size)}，超过单本上限 ${Math.round(maxBytes() / 1048576)}MB，没放进书架（面板里可调「单本最大 MB」）`
        log.warn(line)
        results.push({ ok: false, message: line })
        continue
      }
      try {
        const r = importBuffer(readFileSync(f.path), { name: f.name, source: 'shelf', keepPath: f.path })
        scanned.set(f.name, key)
        if (!r.duplicate) results.push(r)
      } catch (error) {
        scanned.set(f.name, key)
        results.push({ ok: false, message: `《${f.name}》读不了：${error.message}` })
      }
    }
    return results
  }

  // ---------- 读书 ----------

  function startReading(book, chatId, { announce = true } = {}) {
    if (!book) return { ok: false, message: '书架里没有这本书' }
    if (reading) return { ok: false, message: `我正在读《${reading.title}》，等这本读完再读下一本` }
    if (isComic(book)) return startComicReading(book, chatId, { announce })
    if (!store.textOf(book)) return { ok: false, message: `《${book.title}》的正文不见了，重新导入一次吧` }
    const job = { bookId: book.id, title: book.title, chatId, cancel: false, startedAt: Date.now(), kind: 'text' }
    reading = job
    readLoop(job)
      .catch((error) => {
        log.error(`读《${job.title}》出错：`, error.message)
        const cur = store.byId(job.bookId)
        if (cur && cur.status !== 'done') store.updateBook(job.bookId, { status: 'error', error: cut(error.message, 200) })
        if (job.chatId) send(job.chatId, `《${job.title}》没读完：${cut(error.message, 120)}\n下次发 /小说 读 ${job.title} 可以接着读`)
      })
      .finally(() => {
        if (reading === job) reading = null
      })
    const note = book.status === 'done' ? '（再读一遍，更新人物卡）' : book.progress?.done ? '（接着上次读）' : ''
    return {
      ok: true,
      message: announce
        ? `好，我去读《${book.title}》${note}。读的时候还要分段问模型，可能要几分钟，读完告诉你～`
        : '好，我去读了',
    }
  }

  function chunkPlan(book) {
    const chunkChars = clampNum(settings().chunkChars, 1500, 12000, 4500)
    const maxChunks = clampNum(settings().maxChunks, 3, 200, 30)
    const text = store.textOf(book)
    const chunks = splitChunks(text, chunkChars)
    const targets = pickIndices(chunks.length, maxChunks)
    return { text, chunkChars, maxChunks, chunks, targets, sampled: targets.length < chunks.length }
  }

  async function readLoop(job) {
    const book = store.byId(job.bookId)
    if (!book) return
    const { chunks, chunkChars, targets, sampled } = chunkPlan(book)
    if (!chunks.length) throw new Error('正文是空的')

    let notes = store.notesOf(book.id)
    if (!notes || notes.chunkChars !== chunkChars || notes.total !== chunks.length) {
      notes = { version: 1, chunkChars, total: chunks.length, chunks: {}, at: Date.now() }
    }

    const existing = targets.filter((i) => notes.chunks[i]?.ok).length
    book.status = 'reading'
    book.error = ''
    book.progress = { done: existing, total: chunks.length, sampled }
    store.updateBook(book.id, { status: 'reading', error: '', progress: book.progress })
    log.info(`开始读《${book.title}》：${chunks.length} 段里读 ${targets.length} 段${sampled ? '（抽样）' : ''}`)

    let done = existing
    let failed = 0
    let lastNotify = 0
    const reportInChat = job.chatId && String(job.chatId).startsWith('private:') && settings().notifyProgress !== false

    for (const i of targets) {
      if (disposed || job.cancel) {
        book.status = 'paused'
        book.progress = { done, total: chunks.length, sampled }
        store.updateBook(book.id, { status: 'paused', progress: book.progress })
        log.info(`《${book.title}》暂停在第 ${i + 1} 段`)
        return { paused: true }
      }
      if (notes.chunks[i]?.ok) continue
      try {
        const note = await analyzeChunk(api, {
          title: book.title,
          index: i,
          total: chunks.length,
          text: chunks[i],
          strength: strength(),
          extra: settings().extraPrompt,
        })
        if (disposed || job.cancel) {
          // 这期间模块重新加载 / 被叫停了：这一段不算，别把新的状态盖掉
          return { paused: true }
        }
        if (note) {
          notes.chunks[i] = note
          done++
        } else {
          failed++
          log.warn(`《${book.title}》第 ${i + 1} 段没拆出人物（模型没按 JSON 回），跳过`)
        }
      } catch (error) {
        failed++
        log.warn(`《${book.title}》第 ${i + 1} 段读失败：${error.message}`)
      }
      store.saveNotes(book.id, notes)
      book.progress = { done, total: chunks.length, sampled }
      store.updateBook(book.id, { progress: book.progress })

      if (reportInChat && targets.length >= 4 && done < targets.length && done / targets.length >= 0.5 && !lastNotify) {
        lastNotify = 1
        send(job.chatId, `《${book.title}》读到一半了（${done}/${targets.length} 段），等我一会儿～`)
      }
    }

    if (disposed || job.cancel) {
      book.status = 'paused'
      store.updateBook(book.id, { status: 'paused', progress: { done, total: chunks.length, sampled } })
      return { paused: true }
    }

    const okNotes = targets.map((i) => notes.chunks[i]).filter((n) => n && n.ok)
    if (!okNotes.length) throw new Error(`一段都没读成（${failed} 段失败），可能是模型没回应，看看插件日志`)

    const profile = await synthesize(api, {
      title: book.title,
      notes: okNotes,
      strength: strength(),
      extra: settings().extraPrompt,
    }) || mergeLocal(okNotes)

    if (!profile?.characters?.length) throw new Error('读完了，但没整理出人物卡')

    book.status = 'done'
    book.error = ''
    book.progress = { done: okNotes.length, total: chunks.length, sampled }
    book.profile = { ...profile, chunksRead: okNotes.length, sampled, at: Date.now() }
    store.updateBook(book.id, { status: 'done', error: '', progress: book.progress, profile: book.profile })
    log.info(`《${book.title}》读完了，整理出 ${profile.characters.length} 个人物`)

    let auto = ''
    const settingAuto = settings().autoLearn !== false
    if (settingAuto && !store.active() && profile.characters[0]?.name) {
      const c = profile.characters[0]
      store.setActive({ bookId: book.id, name: c.name })
      auto = `我先把${c.name}学上了`
    }

    const names = profile.characters.slice(0, 6).map((c) => c.name + (c.role ? `（${cut(c.role, 12)}）` : '')).join('、')
    const hint = !auto && profile.characters.length
      ? (store.active() ? '想换成书里别的人，发 /小说 学 名字' : '想让我学谁，发 /小说 学 名字')
      : ''
    const lines = [
      `《${book.title}》读完啦${sampled ? `（${chunks.length} 段里抽了 ${okNotes.length} 段）` : ''}。`,
      `书里的人：${names}`,
      auto ? `${auto}，接下来说话会带一点${profile.characters[0].name}的味道～` : '',
      hint,
      failed ? `（有 ${failed} 段没读成，跳过了）` : '',
    ].filter(Boolean)
    if (job.chatId) send(job.chatId, lines.join('\n'))
    return { ok: true }
  }

  function stopReading() {
    if (!reading) return '现在没在读书 / 看漫画'
    reading.cancel = true
    return `好，先不读《${reading.title}》了（下次发 /小说 读 ${reading.title} 接着读）`
  }

  // ---------- 看漫画 ----------
  //
  // 漫画 PDF 没有文字层，只能一页页交给视觉模型看。为了不把 156 页全烧一遍：
  //   · 每「段」几页（设置「每次看几页」，默认 6），长书按 /小说 的「每本最多读几段」均匀抽样；
  //   · 先看开头几页认一份人物名册，后面每段都带着，避免同一人每段换名字、最后合并不起来；
  //   · 看完用和读小说同一套 synthesize 整理人物卡，所以 /小说 角色 / 学 / 卡 全都照旧能用。

  function visionState() {
    if (settings().comicVision === false) return false
    try {
      const lib = api.lib && api.lib('core/llm.js')
      if (!lib || typeof lib.canSeeImages !== 'function') return null
      return lib.canSeeImages(api.dsh, api.config ? api.config() : null)
    } catch (error) {
      return null
    }
  }

  async function assertCanSee() {
    const see = await visionState()
    if (see === false) {
      throw new Error('当前模型看不了图：面板「模型」里换一个支持视觉的，或者把「视觉能力」设成 on')
    }
  }

  /** 页索引没了 / 原 PDF 换过了，就重扫一遍（只记位置，很便宜）。 */
  function ensureComicIndex(book, pdfPath) {
    let index = store.indexOf(book.id)
    let size = 0
    try { size = statSync(pdfPath).size } catch (error) {}
    const ok = index && Array.isArray(index.entries) && index.entries.length && (!size || index.size === size)
    if (ok) return index
    const scan = scanComicPdf(readFileSync(pdfPath))
    index = {
      version: 1,
      pages: scan.pages,
      entries: scan.entries,
      hasFonts: scan.hasFonts,
      size,
      at: Date.now(),
    }
    store.saveIndex(book.id, index)
    if (book.pages !== scan.pages) store.updateBook(book.id, { pages: scan.pages })
    return index
  }

  /** 读一段页的图片；一次请求别塞太大（6 页 1279×1920 的 JPEG 大约 2~3MB）。 */
  function loadPageImages(pdfPath, index, from, to, budget = 5.5 * 1024 * 1024) {
    const images = []
    let bytes = 0
    for (let p = from; p <= to; p++) {
      let img
      try {
        img = readComicPage(p - 1, index, pdfPath)
      } catch (error) {
        log.warn(`第 ${p} 页读不出来：${error.message}`)
        continue
      }
      if (images.length && bytes + img.buffer.length > budget) break
      images.push({ ...img, page: p })
      bytes += img.buffer.length
    }
    return images
  }

  function comicWindows(pages, pageSize) {
    const out = []
    for (let p = 1; p <= pages; p += pageSize) out.push([p, Math.min(pages, p + pageSize - 1)])
    return out
  }

  function startComicReading(book, chatId, { announce = true } = {}) {
    const pdfPath = store.pdfPathOf(book)
    if (!pdfPath || !existsSync(pdfPath)) {
      return { ok: false, message: `《${book.title}》的 PDF 原文件找不到了（可能被移动 / 删了），重新导入一次吧` }
    }
    const job = { bookId: book.id, title: book.title, chatId, cancel: false, startedAt: Date.now(), kind: 'comic' }
    reading = job
    readComicLoop(job)
      .catch((error) => {
        log.error(`看漫画《${job.title}》出错：`, error.message)
        const cur = store.byId(job.bookId)
        if (cur && cur.status !== 'done') store.updateBook(job.bookId, { status: 'error', error: cut(error.message, 200) })
        if (job.chatId) send(job.chatId, `《${job.title}》没看完：${cut(error.message, 140)}\n下次发 /小说 读 ${job.title} 可以接着看`)
      })
      .finally(() => {
        if (reading === job) reading = null
      })
    const pages = Number(book.pages) || 0
    const note = book.status === 'done' ? '（再看一遍，更新人物卡）' : book.progress?.done ? '（接着上次看）' : ''
    return {
      ok: true,
      message: announce
        ? `好，我去看《${book.title}》${note}（${pages} 页）。漫画没有文字层，得一页页看图，会慢一点，看完告诉你～`
        : '好，我去看了',
    }
  }

  async function readComicLoop(job) {
    const book = store.byId(job.bookId)
    if (!book) return
    const pdfPath = store.pdfPathOf(book)
    if (!pdfPath || !existsSync(pdfPath)) throw new Error('漫画的 PDF 原文件找不到了，重新导入一次吧')
    await assertCanSee()

    const index = ensureComicIndex(book, pdfPath)
    if (!index.entries.length) throw new Error('这本 PDF 里没有能看的页面图')

    const pageSize = clampNum(settings().comicPages, 2, 10, 6)
    const maxChunks = clampNum(settings().maxChunks, 3, 200, 30)
    const windows = comicWindows(index.pages, pageSize)
    const targets = pickIndices(windows.length, maxChunks)
    const sampled = targets.length < windows.length

    let notes = store.notesOf(book.id)
    if (!notes || notes.kind !== 'comic' || notes.pageSize !== pageSize || notes.total !== windows.length || notes.pages !== index.pages) {
      notes = {
        version: 2,
        kind: 'comic',
        pageSize,
        total: windows.length,
        pages: index.pages,
        chunks: {},
        roster: null,
        at: Date.now(),
      }
    }

    const pagesOf = (note) => (note && note.ok ? Math.max(0, Number(note.to) - Number(note.from) + 1) : 0)
    let done = targets.reduce((sum, i) => sum + pagesOf(notes.chunks[i]), 0)
    book.status = 'reading'
    book.error = ''
    book.progress = { done, total: index.pages, sampled }
    store.updateBook(book.id, { status: 'reading', error: '', progress: book.progress })
    log.info(`开始看《${book.title}》：${index.pages} 页，每段 ${pageSize} 页，${windows.length} 段里看 ${targets.length} 段${sampled ? '（抽样）' : ''}`)

    // 认人：只做一次，失败也不影响后面看图
    if (!notes.roster) {
      const first = loadPageImages(pdfPath, index, 1, Math.min(3, index.pages))
      if (first.length) {
        try {
          notes.roster = await readComicRoster(api, { title: book.title, images: first })
          store.saveNotes(book.id, notes)
          if (notes.roster?.length) log.info(`《${book.title}》认出 ${notes.roster.length} 个人物：${notes.roster.map((c) => c.name).join('、')}`)
        } catch (error) {
          log.warn(`《${book.title}》认人物失败，先不带名册继续：${error.message}`)
        }
      }
    }

    let failed = 0
    let lastNotify = 0
    const reportInChat = job.chatId && String(job.chatId).startsWith('private:') && settings().notifyProgress !== false

    for (const wi of targets) {
      if (disposed || job.cancel) {
        book.status = 'paused'
        book.progress = { done, total: index.pages, sampled }
        store.updateBook(book.id, { status: 'paused', progress: book.progress })
        log.info(`《${book.title}》停在第 ${windows[wi][0]} 页`)
        return { paused: true }
      }
      if (notes.chunks[wi]?.ok) continue
      const images = loadPageImages(pdfPath, index, windows[wi][0], windows[wi][1])
      if (!images.length) {
        failed++
        log.warn(`《${book.title}》第 ${windows[wi][0]}-${windows[wi][1]} 页一张图都没读出来，跳过`)
        continue
      }
      const from = images[0].page
      const to = images[images.length - 1].page
      try {
        const note = await analyzeComicPages(api, {
          title: book.title,
          from,
          to,
          images,
          roster: notes.roster,
          strength: strength(),
          extra: settings().extraPrompt,
        })
        if (disposed || job.cancel) return { paused: true }
        if (note) {
          notes.chunks[wi] = note
          done += pagesOf(note)
        } else {
          failed++
          log.warn(`《${book.title}》第 ${from}-${to} 页没看成（模型没按 JSON 回），跳过`)
        }
      } catch (error) {
        failed++
        log.warn(`《${book.title}》第 ${from}-${to} 页看失败：${error.message}`)
      }
      store.saveNotes(book.id, notes)
      book.progress = { done, total: index.pages, sampled }
      store.updateBook(book.id, { progress: book.progress })

      if (reportInChat && targets.length >= 4 && done / index.pages >= 0.5 && !lastNotify) {
        lastNotify = 1
        send(job.chatId, `《${book.title}》看了一半了（${done}/${index.pages} 页），等我一会儿～`)
      }
    }

    if (disposed || job.cancel) {
      book.status = 'paused'
      store.updateBook(book.id, { status: 'paused', progress: { done, total: index.pages, sampled } })
      return { paused: true }
    }

    const okNotes = targets.map((i) => notes.chunks[i]).filter((n) => n && n.ok)
    if (!okNotes.length) throw new Error(`一页都没看成（${failed} 段失败），可能是模型看图失败，看看插件日志`)

    const profile = await synthesize(api, {
      title: book.title,
      notes: okNotes,
      strength: strength(),
      extra: settings().extraPrompt,
    }) || mergeLocal(okNotes)
    if (!profile?.characters?.length) throw new Error('看完了，但没整理出人物卡')

    book.status = 'done'
    book.error = ''
    book.progress = { done: Math.min(index.pages, done), total: index.pages, sampled }
    book.profile = { ...profile, kind: 'comic', chunksRead: okNotes.length, sampled, at: Date.now() }
    store.updateBook(book.id, { status: 'done', error: '', progress: book.progress, profile: book.profile })
    log.info(`《${book.title}》看完了，整理出 ${profile.characters.length} 个人物`)

    let auto = ''
    if (settings().autoLearn !== false && !store.active() && profile.characters[0]?.name) {
      const c = profile.characters[0]
      store.setActive({ bookId: book.id, name: c.name })
      auto = `我先把${c.name}学上了`
    }
    const names = profile.characters.slice(0, 6).map((c) => c.name + (c.role ? `（${cut(c.role, 12)}）` : '')).join('、')
    const hint = !auto && profile.characters.length
      ? (store.active() ? '想换成漫画里别的人，发 /小说 学 名字' : '想让我学谁，发 /小说 学 名字')
      : ''
    const lines = [
      `《${book.title}》看完啦${sampled ? `（${index.pages} 页里抽看了 ${book.progress.done} 页）` : `（${index.pages} 页）`}。`,
      `漫画里的人：${names}`,
      auto ? `${auto}，接下来说话会带一点${profile.characters[0].name}的味道～` : '',
      hint,
      failed ? `（有 ${failed} 段没看成，跳过了）` : '',
    ].filter(Boolean)
    if (job.chatId) send(job.chatId, lines.join('\n'))
    return { ok: true }
  }

  /** 给她翻一页看看：聊天里说「漫画第 5 页写了什么」时用。 */
  async function lookPage(titleQuery, page, question) {
    const book = titleQuery ? store.find(titleQuery) : store.books().find(isComic)
    if (!book) return { ok: false, message: '书架上还没有漫画' }
    if (!isComic(book)) return { ok: false, message: `《${book.title}》不是漫画 PDF` }
    const pdfPath = store.pdfPathOf(book)
    if (!pdfPath || !existsSync(pdfPath)) return { ok: false, message: `《${book.title}》的 PDF 原文件找不到了，重新导入一次吧` }
    try {
      await assertCanSee()
    } catch (error) {
      return { ok: false, message: error.message }
    }
    const index = ensureComicIndex(book, pdfPath)
    let n = Math.round(Number(page))
    if (!Number.isFinite(n) || n < 1) n = Math.min(index.pages, (Number(book.progress?.done) || 0) + 1)
    n = Math.max(1, Math.min(index.pages, n))
    let img
    try {
      img = readComicPage(n - 1, index, pdfPath)
    } catch (error) {
      return { ok: false, message: `第 ${n} 页看不了：${error.message}` }
    }
    const ask = String(question || '').trim()
      || '这一页画了什么？把画面上的台词按顺序抄下来（繁体就写繁体），再说这一页在讲什么。'
    try {
      const text = await withTimeout(api.ask({
        system: '你在看一页漫画，用中文回答，不要客套。',
        text: `这是漫画《${book.title}》第 ${n} 页（共 ${index.pages} 页，中文版日本漫画，阅读顺序从右往左、从上往下）。${ask}`,
        images: [{ data: img.buffer.toString('base64'), mediaType: img.mime }],
        maxTokens: 2000,
        reasoningEffort: 'off',
      }), 180000, '看漫画这一页')
      return { ok: true, page: n, pages: index.pages, message: `《${book.title}》第 ${n} 页：${cut(text, 1200)}` }
    } catch (error) {
      return { ok: false, message: `第 ${n} 页没看成：${cut(error.message, 160)}` }
    }
  }

  // ---------- 学角色 ----------

  function findCharacter(query) {
    const q = normKey(query)
    if (!q) return []
    const hits = []
    const order = []
    const a = store.active()
    if (a) order.push(store.byId(a.bookId))
    for (const b of store.books()) order.push(b)
    const seen = new Set()
    for (const b of order) {
      if (!b || seen.has(b.id)) continue
      seen.add(b.id)
      for (const c of b.profile?.characters || []) {
        if (normKey(c.name) === q || normKey(c.name).includes(q) || q.includes(normKey(c.name))) {
          hits.push({ book: b, character: c })
        }
      }
    }
    return hits
  }

  function learn(query, titleHint) {
    const q = String(query || '').trim()
    if (!q) {
      const s = activeStyle()
      const names = allCharacterNames()
      return [
        s ? `现在学的是《${s.book.title}》里的${s.character.name}` : '现在还没学谁。',
        names.length ? `书里有：${names}` : '书架上的书还没读，先发 /小说 读 书名',
        '发 /小说 学 名字 来学他说话做事',
      ].join('\n')
    }
    let hits = findCharacter(q)
    if (titleHint) {
      const book = store.find(titleHint)
      if (book) {
        const only = hits.filter((h) => h.book.id === book.id)
        if (only.length) hits = only
      }
    }
    if (!hits.length) {
      return `书里没找到「${q}」。可以发 /小说 角色 看看有哪些人`
    }
    const hit = hits[0]
    store.setActive({ bookId: hit.book.id, name: hit.character.name })
    const extra = hits.length > 1 ? `（另外 ${hits.length - 1} 本书里也有同名的人，先学了《${hit.book.title}》这个）` : ''
    return `好，我学${hit.character.name}（《${hit.book.title}》）${extra}。接下来说话做事会带点他的味道～\n想换人发 /小说 学 名字，不想学了发 /小说 停`
  }

  function stopLearning() {
    if (!store.active()) return '我现在没在学谁'
    store.setActive(null)
    return '好，不学书里的人了，做回我自己'
  }

  /** 给工具用：把 learn 的文字结果变成 { ok, message }。 */
  function learnSafe(query, titleHint) {
    const message = learn(query, titleHint)
    return { ok: !/^书里没找到/.test(message), message }
  }

  function allCharacterNames() {
    const names = []
    for (const b of store.books()) {
      for (const c of b.profile?.characters || []) {
        const item = `${c.name}（${b.title}）`
        if (!names.includes(item)) names.push(item)
      }
    }
    return names.slice(0, 16).join('、')
  }

  // ---------- 查询文字 ----------

  const STATUS_LABEL = {
    new: '还没读',
    reading: '在读',
    paused: '读了一半',
    done: '读完了',
    error: '读失败了',
  }

  /** 漫画用「看」：还没看 / 在看 / 看了一半 / 看完了 / 看失败了。 */
  function statusLabel(book, status) {
    if (!isComic(book)) return STATUS_LABEL[status] || status
    return { new: '还没看', reading: '在看', paused: '看了一半', done: '看完了', error: '看失败了' }[status] || status
  }

  function shelfText({ withPath = false } = {}) {
    const list = store.books()
    const a = store.active()
    const lines = []
    if (!list.length) {
      lines.push('书架还是空的。')
      lines.push(withPath ? `把小说文件放到：${store.paths.shelf}` : '把小说文件发给我，或者放进书架文件夹')
      lines.push('也可以 /小说 导入 <本地路径或网址>')
      return lines.join('\n')
    }
    lines.push(`书架上有 ${list.length} 本${a ? `；现在学的是《${store.byId(a.bookId)?.title}》里的${a.name}` : ''}`)
    for (const b of list.slice(0, 12)) {
      const p = b.progress || {}
      const pct = b.status === 'done' ? '' : p.total ? ` ${Math.round((p.done / p.total) * 100)}%` : ''
      const tag = formatTag(b)
      lines.push(`· ${tag}《${b.title}》${statusLabel(b, b.status)}${pct}`)
    }
    if (list.length > 12) lines.push(`……还有 ${list.length - 12} 本`)
    if (withPath) lines.push(`放新书：${store.paths.shelf}`)
    return lines.join('\n')
  }

  function statusText() {
    const a = activeStyle()
    const list = store.books()
    const lines = [
      enabled()
        ? (a ? `现在学的是《${a.book.title}》里的${a.character.name}（力度：${strengthLabel()}）` : '现在没学书里的角色')
        : '「学角色」总开关关着（面板里可以打开）',
      `书架：${list.length} 本${list.length ? `（已读 ${list.filter((b) => b.status === 'done').length} 本）` : ''}`,
      reading ? `正在读：《${reading.title}》` : '',
      list.length ? '发 /小说 书架 看书单，/小说 角色 看学到的人物' : `放书：${store.paths.shelf}`,
    ].filter(Boolean)
    return lines.join('\n')
  }

  function strengthLabel() {
    return { light: '轻', medium: '中', strong: '重' }[strength()] || '中'
  }

  function helpText() {
    return [
      '「看小说」怎么用：',
      `· 把 txt / docx / epub / pdf 放到 ${store.paths.shelf}，几秒后自动进书架；也可以直接发我文件，或发 /小说 导入 <路径/网址>`,
      '· 漫画 PDF（一页一张图、没有文字层的那种）也能收：我会一页页看图，抽看一部分，拆人物、学角色',
      '· /小说 书架 — 有哪些书、读到哪了（刚往文件夹里放了新书就发 /小说 刷新）',
      '· /小说 读 书名 — 我去读，读完能学里面的人',
      '· /小说 角色 — 我现在学到了哪些人物',
      '· /小说 学 名字 — 学他的性格、说话、做事方式',
      '· /小说 停 — 不学了，做回我自己',
      '· /小说 停读 — 正在读的长篇先停下（下次接着读）',
      '· /小说 卡 名字 — 看某个人的详细人物卡',
      '· /小说 进度 / /小说 删 书名',
    ].join('\n')
  }

  function charsText(query) {
    const b = query ? store.find(query) : null
    const list = b ? [b] : store.books()
    if (!list.length) return '书架上还没有书，先发我一本小说（txt / docx / epub / pdf）或者 /小说 导入 网址'
    const lines = []
    for (const book of list.slice(0, 8)) {
      const chars = book.profile?.characters || []
      if (!chars.length) {
        lines.push(`《${book.title}》：${statusLabel(book, book.status)}，读完 / 看完才知道有哪些人`)
        continue
      }
      lines.push(`《${book.title}》：${chars.map((c) => c.name + (c.role ? `（${cut(c.role, 10)}）` : '')).join('、')}`)
    }
    const a = store.active()
    lines.push(a ? `现在学的是：${a.name}` : '想让我学谁，发 /小说 学 名字')
    return lines.join('\n')
  }

  function cardText(query) {
    if (!query) {
      const s = activeStyle()
      if (s) return characterCard({ bookTitle: s.book.title, character: s.character })
      return '想看谁的？发 /小说 卡 名字'
    }
    const hits = findCharacter(query)
    if (!hits.length) return `没找到「${query}」，发 /小说 角色 看看有哪些人`
    return characterCard({ bookTitle: hits[0].book.title, character: hits[0].character })
  }

  function progressText() {
    const lines = []
    if (reading) lines.push(`正在读：《${reading.title}》`)
    const list = store.books()
    if (!list.length) return '书架上还没有书'
    for (const b of list.slice(0, 10)) {
      const p = b.progress || {}
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
      let detail = ''
      if (b.status === 'done') detail = p.sampled ? `（${p.total} 段里抽读 ${p.done} 段）` : p.total ? `（${p.total} 段）` : ''
      else if (p.total) detail = ` ${p.done}/${p.total} 段（${pct}%）`
      if (isComic(b)) {
        detail = b.status === 'done'
          ? `（${p.total} 页${p.sampled ? `，抽看 ${Math.min(p.done, p.total)} 页` : ''}）`
          : p.total ? ` ${Math.min(p.done, p.total)}/${p.total} 页（${pct}%）` : ''
      }
      lines.push(`《${b.title}》${statusLabel(b, b.status)}${detail}${b.error ? `：${cut(b.error, 60)}` : ''}`)
    }
    return lines.join('\n')
  }

  function recap(titleQuery, characterQuery) {
    if (!hasBooks()) return { ok: false, message: '书架上还没有书' }
    let book = titleQuery ? store.find(titleQuery) : null
    if (!book) {
      const a = store.active()
      book = (a && store.byId(a.bookId)) || store.books().find((b) => b.profile) || store.books()[0]
    }
    if (!book) return { ok: false, message: '没找到这本书' }
    if (characterQuery) {
      const q = normKey(characterQuery)
      const c = (book.profile?.characters || []).find((x) => normKey(x.name) === q || normKey(x.name).includes(q))
      if (!c) {
        const names = (book.profile?.characters || []).map((x) => x.name).join('、')
        return { ok: false, message: `《${book.title}》里没有「${characterQuery}」${names ? `。有：${names}` : '，这本书还没读'} ` }
      }
      return { ok: true, message: characterCard({ bookTitle: book.title, character: c }) }
    }
    if (!book.profile?.characters?.length) {
      return { ok: false, message: `《${book.title}》还没读完，只知道书名。要我现在读吗？` }
    }
    const p = book.profile
    const out = [
      `《${book.title}》${isComic(book) ? `（漫画 · ${book.pages} 页）` : ''}`,
      p.summary ? `梗概：${cut(p.summary, 500)}` : '',
      p.tone ? `文风：${cut(p.tone, 80)}` : '',
      `人物：${p.characters.map((c) => c.name + (c.role ? `（${cut(c.role, 16)}）` : '')).join('、')}`,
      '想了解谁，可以再说名字（比如「罗辑是个什么样的人」），我用 novel_recap 查人物卡。',
    ].filter(Boolean)
    return { ok: true, message: out.join('\n') }
  }

  // ---------- 命令入口 ----------

  const SUB_ALIASES = {
    书架: 'shelf', 书: 'shelf', 列表: 'shelf', 书单: 'shelf', shelf: 'shelf', list: 'shelf',
    刷新: 'shelf', 扫描: 'shelf', 收书: 'shelf', refresh: 'shelf', scan: 'shelf',
    读: 'read', 看: 'read', 开读: 'read', 读书: 'read', read: 'read',
    导入: 'import', 加: 'import', 收: 'import', 下载: 'import', import: 'import',
    学: 'learn', 模仿: 'learn', 扮演: 'learn', 学会: 'learn', learn: 'learn',
    停: 'stop', 不学: 'stop', 停止: 'stop', stop: 'stop',
    停读: 'stopread', 不读了: 'stopread', stopread: 'stopread',
    角色: 'chars', 人物: 'chars', 人物表: 'chars', chars: 'chars',
    卡: 'card', 档案: 'card', 人物卡: 'card', card: 'card',
    进度: 'progress', progress: 'progress',
    删: 'remove', 删除: 'remove', remove: 'remove', rm: 'remove',
    状态: 'status', status: 'status',
    帮助: 'help', help: 'help', 说明: 'help', '?': 'help',
  }

  async function command(arg, msg) {
    const raw = String(arg || '').trim()
    const m = raw.match(/^(\S+)\s*([\s\S]*)$/)
    const word = m ? m[1] : ''
    let rest = m ? m[2].trim() : ''
    let sub = SUB_ALIASES[word] || ''

    // 中文命令后面不加空格也认：「/小说读三体」「/小说学罗辑」
    // 但如果整个参数本身就是书名 / 人名，就别拆，免得书名叫「读书笔记」时被拆坏
    if (!sub && raw && !store.find(raw) && !findCharacter(raw).length) {
      const prefix = Object.keys(SUB_ALIASES)
        .filter((k) => /[\u4e00-\u9fa5]/.test(k) && raw.startsWith(k))
        .sort((a, b) => b.length - a.length)[0]
      if (prefix) {
        sub = SUB_ALIASES[prefix]
        rest = raw.slice(prefix.length).trim()
      }
    }

    if (!raw) return `${statusText()}\n\n${helpText()}`
    if (!sub) {
      const book = store.find(raw)
      if (book) sub = 'read'
      else if (findCharacter(raw).length) sub = 'card'
      else return `看不懂「${raw}」。\n${helpText()}`
      if (sub === 'read') return command(`读 ${raw}`, msg)
      return cardText(raw)
    }

    switch (sub) {
      case 'help':
        return helpText()
      case 'status':
        return statusText()
      case 'shelf': {
        const news = scanShelf()
        const just = news.filter((r) => r.ok && !r.duplicate).map((r) => r.message)
        return [just.length ? `新收到：\n${just.join('\n')}` : '', shelfText({ withPath: true })].filter(Boolean).join('\n\n')
      }
      case 'read': {
        if (!rest) return store.books().length ? `读哪本？\n${shelfText()}\n\n发 /小说 读 书名` : '书架是空的，先发我一本小说'
        const book = store.find(rest)
        if (!book) return `书架上没有「${rest}」。\n${shelfText()}`
        const r = startReading(book, msg.chatId)
        return r.message
      }
      case 'import': {
        if (!rest) {
          const rs = scanShelf()
          if (!rs.length) return `没发现新书。把小说文件放进：${store.paths.shelf}`
          return rs.map((r) => r.message).join('\n')
        }
        const r = /^https?:\/\//i.test(rest) ? await importUrl(rest) : importPath(rest)
        return r.message
      }
      case 'learn': {
        const m2 = rest.match(/^(.+?)\s*@\s*(.+)$/)
        if (m2) return learn(m2[1].trim(), m2[2].trim())
        return learn(rest)
      }
      case 'stop':
        return stopLearning()
      case 'stopread':
        return stopReading()
      case 'chars':
        return charsText(rest)
      case 'card':
        return cardText(rest)
      case 'progress':
        return progressText()
      case 'remove': {
        if (!rest) return '删哪本？发 /小说 删 书名'
        const book = store.find(rest)
        if (!book) return `书架上没有「${rest}」`
        if (reading?.bookId === book.id) reading.cancel = true
        const wasActive = store.active()?.bookId === book.id
        store.removeBook(book.id)
        return `删掉《${book.title}》了${wasActive ? '，也不学里面的人了' : ''}`
      }
      default:
        return helpText()
    }
  }

  // ---------- QQ 文件 ----------


  /** message 事件用：主人发来 txt / docx / epub / pdf 就收下并开读。返回 true = 这条消息我接管了。 */
  async function handleFileMessage(msg) {
    if (settings().autoReadFile === false) return false
    if (!api.isOwner(msg.userId)) return false
    const segs = Array.isArray(msg.raw?.message) ? msg.raw.message : []
    const fileSeg = segs.find((s) => s && s.type === 'file')
    if (!fileSeg) return false
    const data = fileSeg.data || {}
    const name = String(data.name || data.file_name || data.file || '小说.txt')
    if (!/\.(txt|md|text|docx|epub|pdf)$/i.test(name)) {
      await send(msg.chatId, `这个文件（${name}）我只会看 txt / docx / epub / pdf 小说，别的格式认不出来`)
      return true
    }
    // 文件大小消息段里就有：超上限就别下，直接告诉她怎么办（别等两分钟再报超时）
    const sizeHint = Number(data.file_size || data.size || 0)
    if (sizeHint > maxBytes()) {
      // QQ 的离线文件通道实测约 60KB/s，按这个估个大概时间
      const mins = Math.round(sizeHint / (60 * 1024) / 60)
      await send(msg.chatId, [
        `「${name}」有 ${mbLabel(sizeHint)}，超过单本上限 ${Math.round(maxBytes() / 1048576)}MB。`,
        `· 想让我读：面板里把「单本最大 MB」调到 ${Math.ceil(sizeHint / 1048576)} 以上（QQ 文件通道只有几十 KB/s${mins >= 2 ? `，这个大小大概要下 ${mins} 分钟，容易超时` : ''}）`,
        `· 更快：直接把文件拷到 ${store.paths.shelf}（也受这个上限限制），我 5 分钟内自己收；急的话发 /小说 刷新`,
      ].join('\n'))
      return true
    }
    await send(msg.chatId, `收到「${name}」${sizeHint ? `（${mbLabel(sizeHint)}）` : ''}，我先把书收下…`)
    try {
      let lastNote = 0
      const onProgress = settings().notifyProgress === false ? null : (done, total) => {
        if (!total || done >= total) return
        const now = Date.now()
        if (now - lastNote < 60_000) return
        lastNote = now
        send(msg.chatId, `还在下「${name}」：${mbLabel(done)} / ${mbLabel(total)}…`)
      }
      const buf = await fetchQQFile(api, msg, data, {
        maxBytes: maxBytes(),
        timeoutMs: downloadBudgetMs(),
        onProgress,
      })
      const r = importBuffer(buf, { name, source: 'qq' })
      if (!r.ok) {
        await send(msg.chatId, r.message)
        return true
      }
      if (r.duplicate) {
        const next = r.book.status === 'done'
          ? `想再读一遍发 /小说 读 ${r.book.title}`
          : startReading(r.book, msg.chatId).message
        await send(msg.chatId, `${r.message}\n${next}`)
        return true
      }
      const started = startReading(r.book, msg.chatId)
      await send(msg.chatId, `${r.message}\n${started.message}`)
    } catch (error) {
      // 原始错误（网关 / HTTP / 超时）只写日志，聊天里说人话——以前会把 OneBot 的报错整段倒给她
      log.warn(`收 QQ 文件失败（${name}）：${error?.message || error}`)
      const raw = String(error?.message || error)
      const shelf = store.paths.shelf
      if (error?.code === 'TOO_BIG') {
        await send(msg.chatId, `${raw}\n· 想让我读：面板把「单本最大 MB」调大\n· 更快：直接把文件拷到 ${shelf}，我 5 分钟内自己收`)
        return true
      }
      const short = /超时/.test(raw) ? '下载超时（QQ 文件通道太慢）'
        : (raw.match(/HTTP \d{3}/) || [])[0]
        || (/file_id not found|没给出文件下载地址/i.test(raw) ? 'QQ 没给出下载地址' : raw.replace(/\s+/g, ' ').slice(0, 40))
      await send(msg.chatId, `文件没拿到：${short}\n直接把文件拷到 ${shelf} 更快，我 5 分钟内自己收；急的话发 /小说 刷新。`)
    }
    return true
  }

  async function send(chatId, text) {
    if (!chatId || !text) return
    try {
      await api.send(chatId, text)
    } catch (error) {
      log.warn(`发消息失败：${error.message}`)
    }
  }

  // ---------- 定时 ----------

  async function tick() {
    if (settings().autoScan === false) return
    const results = scanShelf({ limit: 5 })
    // 书架里的文件没进书架（太大 / 读不了）时跟主人说一声，别让她以为收了
    const bad = (results || []).filter((r) => r && r.ok === false)
    const owner = String(api.config?.()?.ownerQQ || '')
    if (!bad.length || !owner) return
    await send(`private:${owner}`, `书架里有文件没进书架：\n${bad.map((r) => `· ${r.message}`).join('\n')}`)
  }

  function dispose() {
    disposed = true
  }

  function readingState() {
    return reading ? { title: reading.title, startedAt: reading.startedAt } : null
  }

  return {
    // 数据
    store,
    // 事件用
    personaBlock: personaBlockText,
    contextText,
    ruleLineText,
    handleFileMessage,
    // 命令 / 工具
    command,
    helpText,
    statusText,
    shelfText,
    charsText,
    cardText,
    progressText,
    recap,
    learn,
    learnSafe,
    stopLearning,
    startReading,
    stopReading,
    lookPage,
    isComic,
    importBuffer,
    importPath,
    importUrl,
    scanShelf,
    // 杂
    activeStyle,
    hasBooks,
    readingState,
    tick,
    dispose,
  }
}
