// 扩展模块「看小说」—— 放在 Aurabot 数据目录 modules/novel/ 里，插件升级不会动它。
// 保存就生效（几秒内自动重新加载），出错了去面板「扩展」页看原因；接口说明见同目录上一层的 API.md。
//
// 她会：
//   · 把小说读进书架（txt / docx / epub / pdf；放到 shelf 文件夹 / 发 QQ 文件 / 导入本地路径或网址）
//   · 分段读，拆出书里人物的性格、说话方式、做事风格和原话，整理成人物卡
//   · 学其中某个角色：说话做事带一点那个人的味道（人格里加一段，不是扮演，也不会变成另一个人）
//   · 记得书里的情节和人物，别人聊起来能接上话
//
// 命令（只有主人能用）：/小说 帮助 里都有。

import { createOps } from './ops.mjs'

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'novel',
  name: '看小说',
  version: '1.1.0',
  api: 1,
  description: '读小说（txt / docx / epub / pdf），学书里角色的性格、说话和做事方式',

  defaults: {
    enabled: true,
    autoLearn: true,
    strength: 'medium',
    chunkChars: 4500,
    maxChunks: 30,
    autoScan: true,
    autoReadFile: true,
    notifyProgress: true,
    maxFileMB: 20,
    extraPrompt: '',
  },

  settings: [
    { key: 'enabled', label: '学角色（总开关）', type: 'switch', hint: '关掉后她不再带着书里角色的味道说话，读过的书和人物卡都还在' },
    { key: 'autoLearn', label: '读完自动学主角', type: 'switch', hint: '读完一本就自动学书里最主要的那个角色；想换人发 /小说 学 名字' },
    {
      key: 'strength',
      label: '学的力度',
      type: 'select',
      options: [
        { value: 'light', label: '轻：只带一点性格和语气' },
        { value: 'medium', label: '中：性格、说话、做事都学' },
        { value: 'strong', label: '重：连口头禅和腔调都学' },
      ],
      hint: '越重占用的提示词越多，也越像那个人',
    },
    { key: 'chunkChars', label: '每次读多少字', type: 'number', min: 1500, max: 12000, step: 500, hint: '太长的小说会自动抽样，不是每一段都读' },
    { key: 'maxChunks', label: '每本书最多读几段', type: 'number', min: 3, max: 200, step: 1, hint: '越多人物越准，也越费模型调用；30 段约能覆盖 13 万字' },
    { key: 'autoScan', label: '自动收书', type: 'switch', hint: '往书架文件夹里放小说（txt / docx / epub / pdf），过几分钟自动加进书架' },
    { key: 'autoReadFile', label: '主人发小说自动读', type: 'switch', hint: '主人在 QQ 里发 txt / docx / epub / pdf 文件时，自动收下并开始读' },
    { key: 'notifyProgress', label: '读的时候在私聊报进度', type: 'switch' },
    { key: 'maxFileMB', label: '单本最大 MB', type: 'number', min: 1, max: 200, step: 1 },
    { key: 'extraPrompt', label: '读小说时的额外要求', type: 'textarea', hint: '比如「重点学女性角色」「多收集口头禅」；会附在每次分析的提示词里' },
  ],

  setup(api) {
    const ops = createOps({ api })
    const store = ops.store

    // 1. 人格：她最近在读的书 + 学到的人物，拼在她的原人格后面
    api.on('persona', (text) => {
      const block = ops.personaBlock()
      if (!block) return undefined
      return `${String(text || '')}\n\n${block}`
    })

    // 2. 每轮一句提醒，防止她把「学角色」演成换人 / 满嘴原著台词
    api.context(() => ops.contextText())

    // 3. 补规则：她知道自己在读什么、能查什么
    api.rule((kind) => ops.ruleLineText(kind))

    // 4. 主人发来 txt 文件：收下并开读
    api.on('message', async (msg) => ops.handleFileMessage(msg))

    // 5. 命令（只有主人能用）
    api.command({
      name: '小说',
      aliases: ['novel', 'book'],
      desc: '看小说、学书里角色的性格和说话方式（/小说 帮助）',
      run: async (arg, msg) => {
        try {
          return await ops.command(arg, msg)
        } catch (error) {
          api.log.warn('「看小说」命令出错：', error.message)
          return `出错了：${error.message}`
        }
      },
    })

    // 6. 给她自己用的工具（她在聊天里决定什么时候查、什么时候读）
    const isOwnerTurn = (sessionId, chat) => {
      try {
        if (api.core?.hub?.turnHasOwner?.(sessionId)) return true
      } catch (error) {}
      return Boolean(chat?.userId && api.isOwner(chat.userId))
    }

    api.tool((where) => {
      const chat = where?.chat || {}
      if (chat.kind === 'system') return []
      const tools = [
        api.defineTool({
          name: 'novel_shelf',
          description: '看她最近在读哪些小说、书架上有什么书、现在学的是书里哪个角色。聊到她在看什么书、或者别人问她在干嘛时可以用。',
          properties: {},
          execute: async () => ({ ok: true, message: ops.shelfText() }),
        }),
        api.defineTool({
          name: 'novel_recap',
          description: '查一本小说的梗概，或者书里某个角色的性格、说话方式、做事风格和原话。别人聊起书里的情节人物、或者你想学某个角色说话时，先查这个，别编。',
          properties: {
            title: { type: 'string', description: '书名，不填就是她最近在读的那本' },
            character: { type: 'string', description: '角色名；填了就返回这个人的详细人物卡' },
          },
          execute: async ({ title, character }) => ops.recap(title, character),
        }),
        api.defineTool({
          name: 'novel_read',
          description: '开始读一本已经在书架上的小说。主人说「你去看看某本书」时用。读的时候要花几分钟，读完会整理人物。',
          properties: {
            title: { type: 'string', description: '书名' },
          },
          required: ['title'],
          execute: async ({ title }) => {
            if (!isOwnerTurn(where.sessionId, chat)) return { ok: false, message: '只有主人能让我读小说' }
            const book = store.find(title)
            if (!book) return { ok: false, message: `书架上没有「${title}」。把小说文件发给我，或者让主人用 /小说 导入` }
            return ops.startReading(book, chat.chatId, { announce: false })
          },
        }),
        api.defineTool({
          name: 'novel_learn',
          description: '学书里某个角色的性格、说话和做事方式（主人说「学学某某说话」「像某某那样」时用）。学完下一轮开始生效。',
          properties: {
            name: { type: 'string', description: '角色名' },
            title: { type: 'string', description: '书名，不填就在所有书里找' },
          },
          required: ['name'],
          execute: async ({ name, title }) => {
            if (!isOwnerTurn(where.sessionId, chat)) return { ok: false, message: '只有主人能让我学小说里的角色' }
            return ops.learnSafe(name, title)
          },
        }),
      ]
      return tools
    })

    // 7. 定时检查书架文件夹（往里面丢 txt 就自动收）
    api.later(8000, () => {
      try {
        ops.scanShelf({ limit: 5 })
      } catch (error) {
        api.log.warn('自动收书出错：', error.message)
      }
    })
    api.every(5 * 60_000, () => ops.tick(), '看小说-检查书架')

    // 8. 模块停下时让正在进行的阅读知道别再写了
    api.onDispose(() => ops.dispose())

    return {
      shelf: () => store.books(),
      active: () => ops.activeStyle(),
      learn: (name, title) => ops.learn(name, title),
      stop: () => ops.stopLearning(),
      read: (title, chatId) => {
        const book = store.find(title)
        return book ? ops.startReading(book, chatId) : { ok: false, message: `书架上没有「${title}」` }
      },
      status: () => ops.statusText(),
    }
  },
}
