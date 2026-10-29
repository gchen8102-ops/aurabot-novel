// 「看小说」的验证：格式解析（docx / epub / pdf）、导入书架、书架文件夹、QQ 文件下载。
//
// 跑法：node test.mjs
//
// 会跳过的项（仓库里不放大文件和令牌，所以别人 clone 下来也能跑）：
// · docx 那几项需要本地的 1.txt（一份 docx 改名的样书）：没有就 SKIP
// · 真网关那几项需要会话令牌：设 ONEBOT_TOKEN 环境变量才跑，否则 SKIP
//   （ONEBOT_FILE_ID / ONEBOT_FILE_URL 可选，用来指向一个测过的 QQ 文件）

import { readFileSync, mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { docxToText, looksLikeZip, epubToText, pdfToText, documentText } from './text.mjs'
import { createOps, fetchQQFile } from './ops.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '.testdata')
const TOKEN = String(process.env.ONEBOT_TOKEN || '').trim()
const GATEWAY = String(process.env.ONEBOT_GATEWAY || 'http://127.0.0.1:3000/')
const FILE_ID = String(process.env.ONEBOT_FILE_ID || '4ea8c4b9f95b09df4de35ea1c783c368_c12d7932-d2e0-11f1-b4ee-5323d40aefed')
const FILE_URL = String(process.env.ONEBOT_FILE_URL || '')

let failed = 0
let skipped = 0
const ok = (label, cond, extra = '') => {
  if (cond) console.log('PASS ' + label + (extra ? ' — ' + extra : ''))
  else { failed++; console.log('FAIL ' + label + (extra ? ' — ' + extra : '')) }
}
const skip = (label, why = '') => {
  skipped++
  console.log('SKIP ' + label + (why ? ' — ' + why : ''))
}

// 真网关的 OneBot 调用
async function onebot(action, params) {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + TOKEN },
    body: JSON.stringify({ action, params, echo: 'novel-test' }),
    signal: AbortSignal.timeout(15000),
  })
  return res.json()
}

const settings = {
  enabled: true, autoLearn: true, strength: 'medium', chunkChars: 4500, maxChunks: 30,
  autoScan: true, autoReadFile: true, notifyProgress: true, maxFileMB: 20, extraPrompt: '',
}

function makeApi(onebotImpl) {
  return {
    dataDir: () => dataDir,
    settings: () => ({ ...settings }),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    isOwner: () => true,
    send: async () => {},
    onebot: onebotImpl,
  }
}

rmSync(dataDir, { recursive: true, force: true })
mkdirSync(dataDir, { recursive: true })

const fixture = join(here, '1.txt')
const hasDocx = existsSync(fixture)
const docx = hasDocx ? readFileSync(fixture) : null

// ---- 1. docx 拆正文 ----
if (hasDocx) {
  ok('识别 zip/docx', looksLikeZip(docx))
  const text = docxToText(docx)
  ok('docx 抽到正文', text.length > 1000, text.length + ' 字')
  ok('docx 第一个段落', text.trim().startsWith('《我的妹妹才不会这么可爱！才怪！》'), JSON.stringify(text.trim().slice(0, 30)))
  ok('docx 保留对白', text.includes('笨蛋老哥') && text.includes('专属底层沙包'))
} else {
  skip('docx 拆正文（1-4 项）', '本地没有 1.txt 样书')
}
ok('非 zip 不误判', docxToText(Buffer.from('第一章 测试\n正文正文')) === '')

// ---- 1.5 epub / pdf ----
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()
function crc32(buf) {
  let c = 0 ^ -1
  for (const byte of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ byte) & 0xff]
  return (c ^ -1) >>> 0
}
function makeZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBuf, eocd])
}

const epub = makeZip([
  ['META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
  ['OEBPS/content.opf', '<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>'],
  ['OEBPS/a.xhtml', '<html><body><p>第一章正文，换个格式也要读出来。</p></body></html>'],
  ['OEBPS/b.xhtml', '<html><body><p>第二章正文，顺序不能乱。</p></body></html>'],
])
const epubText = epubToText(epub)
ok('epub 抽到正文', epubText.includes('第一章正文'), JSON.stringify(epubText.slice(0, 40)))
ok('epub 按 spine 顺序', epubText.indexOf('第一章正文') < epubText.indexOf('第二章正文'))
ok('epub 自动识别', documentText(epub, 'x.epub').kind === 'epub')

function buildPdf(objects) {
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n'
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
const asciiContent = 'BT /F1 12 Tf 72 720 Td (PDF text works) Tj ET'
const pdf = buildPdf([
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>',
  `<< /Length ${asciiContent.length} >>\nstream\n${asciiContent}\nendstream`,
])
ok('pdf 抽到正文', pdfToText(pdf).includes('PDF text works'), JSON.stringify(pdfToText(pdf)))
ok('pdf 自动识别', documentText(pdf, 'x.pdf').kind === 'pdf')
ok('坏 pdf 不崩', pdfToText(Buffer.from('%PDF-1.4 broken')) === '')

// ---- 2. 导入书架（真 docx，名字叫 1.txt） ----
const ops = createOps({ api: makeApi(onebot) })
if (hasDocx) {
  const r1 = ops.importBuffer(docx, { name: '1.txt', source: 'qq' })
  ok('导入成功', r1.ok === true, r1.message)
  ok('书名从正文抬头来', r1.book?.title === '我的妹妹才不会这么可爱！才怪！', r1.book?.title)
  ok('正文入库', (ops.store.textOf(r1.book) || '').includes('笨蛋老哥'))
  ok('书架 1 本', ops.store.books().length === 1)
  const r2 = ops.importBuffer(docx, { name: '1.txt' })
  ok('重复导入被认出来', r2.ok === true && r2.duplicate === true, r2.message)
} else {
  skip('导入书架（2 项）', '本地没有 1.txt 样书')
}

// ---- 3. 书架文件夹认 docx 后缀 ----
if (hasDocx) {
  copyFileSync(fixture, join(dataDir, 'shelf', '妹妹.docx'))
  const shelf = ops.store.shelfFiles()
  ok('shelf 收 docx', shelf.some((f) => f.name === '妹妹.docx'), shelf.map((f) => f.name).join(','))
  const scan = ops.scanShelf()
  ok('扫描书架跳过重复书', scan.length === 0 && ops.store.books().length === 1)
} else {
  skip('书架文件夹收 docx', '本地没有 1.txt 样书')
}

// ---- 4-7. QQ 文件下载（要真网关） ----
const msgPrivate = { kind: 'private', chatId: 'private:3116673102', userId: '3116673102' }
if (TOKEN && FILE_URL) {
  const b1 = await fetchQQFile(makeApi(onebot), msgPrivate, { name: '1.txt', file_id: FILE_ID, url: FILE_URL })
  ok('直链下载', b1.length > 0, b1.length + ' 字节')
  ok('直链下到的是 docx', docxToText(b1).includes('笨蛋老哥'))

  const b2 = await fetchQQFile(makeApi(onebot), msgPrivate, { name: '1.txt', file_id: FILE_ID })
  ok('get_private_file_url 拿到文件', b2.length > 0, b2.length + ' 字节')

  const calls = []
  const fakeApi = makeApi(async (action) => {
    calls.push(action)
    if (action === 'get_group_file_url') return { status: 'ok', data: { url: FILE_URL } }
    return { status: 'ok', data: { url: 'http://127.0.0.1:9/nope' } }
  })
  const b3 = await fetchQQFile(fakeApi, { kind: 'group', groupId: '646015746' }, { file_id: 'abc/def', busid: 102 })
  ok('群文件先调 get_group_file_url', calls[0] === 'get_group_file_url', calls.join(' → '))
  ok('群文件下载成功', b3.length > 0)

  let err = ''
  try {
    await fetchQQFile(makeApi(async (action) => ({ status: 'failed', retcode: 100, data: null, wording: action + ' 失败：file_id not found' })), msgPrivate, { file_id: 'bogus-id' })
  } catch (error) { err = error.message }
  ok('错误信息带接口名', /get_private_file_url/.test(err) && /get_file/.test(err), err)
} else {
  skip('QQ 文件下载（4-7 项）', '没设 ONEBOT_TOKEN / ONEBOT_FILE_URL')
}

// ---- 8. 普通 txt 还能正常导入（不误判成 docx） ----
writeFileSync(join(here, '.plain.txt'), '第一章 测试\n' + '这是一本普通的小说正文。'.repeat(40), 'utf8')
const r3 = ops.importBuffer(readFileSync(join(here, '.plain.txt')), { name: '普通小说.txt' })
ok('普通 txt 导入', r3.ok === true && r3.book.title === '普通小说', r3.message)

// ---- 9. 重发同一本书：接着读，而不是只回「已经在书架上了」 ----
if (hasDocx && TOKEN) {
  const sent = []
  const api9 = makeApi(onebot)
  api9.send = async (_chatId, text) => { sent.push(String(text)) }
  api9.ask = async () => { throw new Error('测试里不真读') }
  const ops9 = createOps({ api: api9 })
  ops9.importBuffer(docx, { name: '1.txt' })
  const handled = await ops9.handleFileMessage({
    kind: 'private',
    chatId: 'private:3116673102',
    userId: '3116673102',
    raw: { message: [{ type: 'file', data: { name: '1.txt', file_id: FILE_ID } }] },
  })
  ok('重发：消息被接管', handled === true)
  ok('重发：认出已在书架', sent.some((t) => t.includes('已经在书架上了')), sent.join(' | '))
  ok('重发：直接开读', sent.some((t) => t.includes('我去读')), sent.join(' | '))
} else {
  skip('重发同一本书', '本地没有 1.txt 样书 / 没设 ONEBOT_TOKEN')
}

console.log(failed ? `\n有 ${failed} 项没过${skipped ? `（跳过 ${skipped} 项）` : ''}` : `\n全部通过${skipped ? `（跳过 ${skipped} 项）` : ''}`)
process.exit(failed ? 1 : 0)
