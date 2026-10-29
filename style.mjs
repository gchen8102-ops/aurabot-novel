// 把她学到的人物变成「人格附加段」「每轮提醒」「规则」。
// 只负责生成文字，不碰数据；力气大小由设置里的 strength 控制。

import { cut, stripQuote } from './text.mjs'

const LEVELS = {
  light: { max: 340, behavior: false, catchphrases: false, quotes: 0 },
  medium: { max: 720, behavior: true, catchphrases: true, quotes: 2 },
  strong: { max: 1100, behavior: true, catchphrases: true, quotes: 3 },
}

export function normalizeStrength(v) {
  return Object.prototype.hasOwnProperty.call(LEVELS, v) ? v : 'medium'
}

/** 人格后面追加的「在读」一段。没有正在学的角色就返回空串。 */
export function personaBlock({ bookTitle, character, strength }) {
  const c = character || {}
  if (!c.name) return ''
  const level = LEVELS[normalizeStrength(strength)]
  const lines = []
  lines.push(`【你最近在读《${bookTitle}》】`)
  lines.push(`你很喜欢书里的${c.name}，说话做事会不知不觉带着${c.name}的影子（不是扮演，别自称${c.name}，也别说“我在模仿”）：`)
  if (c.personality) lines.push(`- 性子：${cut(c.personality, 130)}`)
  if (c.speech) lines.push(`- 说话：${cut(c.speech, 150)}`)
  if (level.behavior && c.behavior) lines.push(`- 做事：${cut(c.behavior, 150)}`)
  if (level.catchphrases && (c.catchphrases || []).length) {
    lines.push(`- 爱挂在嘴边：${(c.catchphrases || []).slice(0, 4).map((x) => cut(x, 24)).join('、')}`)
  }
  const quotes = (c.quotes || []).slice(0, level.quotes)
  if (quotes.length) lines.push(`- 那种味道：${quotes.map((q) => `“${cut(stripQuote(q), 90)}”`).join(' / ')}`)
  lines.push('用这种性子去反应就好，别硬套台词，也别突然变成另一个人。')
  let text = lines.join('\n')
  if (text.length > level.max) text = text.slice(0, level.max - 1) + '…'
  return text
}

/** 每轮塞进上下文的短句：提醒她别把「学角色」演成换人。 */
export function contextLine({ bookTitle, character }) {
  if (!character?.name) return ''
  return `（你现在说话做事带着《${bookTitle}》里${character.name}的味道；不用主动提这本书，聊到了再说，也别自称是${character.name}。）`
}

/** 补一条规则（api.rule 每轮调用）。 */
export function ruleLine({ bookTitle, character, kind }) {
  if (!character?.name) return ''
  const who = kind === 'social' ? '跟群里的人聊天时' : '跟主人聊天时'
  return `${who}，你说话做事会带一点《${bookTitle}》里${character.name}的味道（性格、语气、做事的反应），但你还是你自己：别自称${character.name}，别说自己在模仿，也别突然换成书里的世界观。`
}

/** 给工具 / 命令看的简短人物卡。 */
export function characterCard({ bookTitle, character, full = true }) {
  const c = character || {}
  const out = [`《${bookTitle}》· ${c.name}${c.role ? `（${c.role}）` : ''}`]
  if (c.personality) out.push(`性子：${cut(c.personality, full ? 300 : 120)}`)
  if (c.speech) out.push(`说话：${cut(c.speech, full ? 300 : 120)}`)
  if (c.behavior) out.push(`做事：${cut(c.behavior, full ? 300 : 120)}`)
  if ((c.catchphrases || []).length) out.push(`口头禅：${c.catchphrases.map((x) => cut(x, 24)).join('、')}`)
  if (full && (c.quotes || []).length) out.push(`原话：\n${c.quotes.map((q) => `· “${cut(stripQuote(q), 160)}”`).join('\n')}`)
  return out.join('\n')
}
