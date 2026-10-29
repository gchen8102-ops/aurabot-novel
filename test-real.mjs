// 拿真实文件验证「能不能读」：node test-real.mjs <文件...>
//
// 不调模型、不发消息、不连 QQ —— 只走「读文件 → 抽正文 → 进书架」这一段，
// 打印格式、字数、正文开头，方便肉眼判断抽出来的是不是人话。
//
//   node test-real.mjs D:\books\某本.epub D:\books\某本.pdf
//
// 有问题的文件会让退出码变成 1。

import { readFileSync, existsSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createOps } from './ops.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const files = process.argv.slice(2)
if (!files.length) {
  console.log('用法：node test-real.mjs <小说文件...>')
  process.exit(2)
}

const dataDir = join(here, '.testdata-real')
const api = {
  dataDir: () => dataDir,
  settings: () => ({ enabled: true, maxFileMB: 200, chunkChars: 4500, maxChunks: 30 }),
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  isOwner: () => true,
  send: async () => {},
  onebot: async () => ({}),
}
const ops = createOps({ api })

let bad = 0
for (const file of files) {
  const name = basename(file)
  console.log(`\n=== ${name}${existsSync(file) ? '' : '（找不到）'}`)
  if (!existsSync(file)) { bad++; continue }
  const t0 = Date.now()
  const r = ops.importBuffer(readFileSync(file), { name, source: 'path' })
  const ms = Date.now() - t0
  if (!r.ok && !r.duplicate) {
    console.log(`✗ ${r.message}`)
    bad++
    continue
  }
  const book = r.book
  const text = ops.store.textOf(book)
  const han = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const badChars = (text.match(/\uFFFD/g) || []).length
  console.log(`✓ 《${book.title}》 ${book.format || 'txt'}${book.pages ? ` · ${book.pages} 页` : ''} · ${text.length} 字 · 汉字 ${han} · ${ms}ms`)
  if (badChars) console.log(`  ⚠ 有 ${badChars} 个替换符（乱码）`)
  console.log('  开头：' + JSON.stringify(text.slice(0, 160)))
  if (text.length < 200 || badChars > text.length * 0.05) bad++
}

console.log(bad ? `\n有 ${bad} 个文件读得不理想` : '\n都能读')
process.exit(bad ? 1 : 0)
