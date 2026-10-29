# 发布攻略（aurabot-novel）

> 对象：Aurabot 扩展模块「看小说 / 漫画」。发出去之后，别人解压到自己的 `modules/` 就能用。
> 跟着抄命令就行，每步都给了验证方法。当前版本 **1.2.1**。

---

## 0. 先记住三条：这些**永远不许**进仓库 / 进 zip

| 不许进 | 为什么 | 在哪 |
|---|---|---|
| 任何小说 / 漫画文件（`1.txt`、`.testdata/`、`.tmpcomic*/`） | 是**盗版书**或别人的文稿，传上去就是替别人侵权 | 根目录、`.testdata/` |
| 会话令牌 `ONEBOT_TOKEN` | 等于 QQ 网关的钥匙，拿到的人能冒充你的机器人 | `test.mjs` 已经从代码里删掉，只从环境变量读 |
| `library.json` / `modules-data/` | 里面是**你看过什么书、学的是谁**，属于个人数据 | 不在这个文件夹里，别手动往里拷 |

`.gitignore` 已经拦住了 1、3；第 2 条靠「代码里不写死」。
**每次 push 前跑一遍第 5 步的自查**，别嫌烦。

> 1.2.0 新增的坑：真机测试时会往 `modules-data/` 里写漫画页索引和笔记（在 Aurabot 数据目录，不在仓库里），
> 但**别把 `D:\C7208\...` 的 PDF 或临时副本**放进 `novel-mod/`。测完把 `.tmpcomic*/` 删掉。

---

## 1. 打包

```powershell
cd C:\Users\陈业昌\Aurabot\qq-chats\novel-mod

# 这台机器没有 pwsh（PowerShell 7），用 Windows PowerShell：
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1

# 装了 PowerShell 7 的机器也可以用：
# pwsh -File build.ps1
```

会做四件事：

1. 检查 `index.mjs` 和 `package.json` 的版本号是否一致（不一致直接报错）
2. 只把 `package.json` → `files` 里列的运行文件复制进 `dist\stage\novel\`
3. 压成 `dist\aurabot-novel-<版本>.zip`（zip 里有一层 `novel/`，解压到 `modules` 就位）
4. 打印每个文件的大小 + SHA256，并检查包里有没有混进样书 / 备份（有就报错）

1.2.1 的 zip 应该包含：

```text
index.mjs  ops.mjs  store.mjs  text.mjs  textutil.mjs  zip.mjs
epub.mjs   pdf.mjs  comic.mjs  learn.mjs  style.mjs
README.md  CHANGELOG.md  LICENSE
```

验证：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build.ps1 -KeepStage
Get-ChildItem dist\stage\novel
```

---

## 2. 推代码（仓库已经建好了，从 1.2.0 起是更新，不是新建）

仓库：<https://github.com/gchen8102-ops/aurabot-novel>（public，默认分支 `main`）

```powershell
cd C:\Users\陈业昌\Aurabot\qq-chats\novel-mod

# 先看一眼改了什么
git status --short
git log --oneline -3

git push origin main
```

这台机器直连 github.com 不通、`127.0.0.1:7897` 有代理，仓库里已经这样配过：

```text
http.https://github.com.proxy = http://127.0.0.1:7897
http.sslBackend = openssl
```

> 如果新机器没配：`git config --global http.https://github.com.proxy http://127.0.0.1:7897`
> 和 `git config --global http.sslBackend openssl`。push 时凭据走 Windows 凭据管理器
> （`credential.helper=manager`），第一次可能要登一次 GitHub。

---

## 3. 发 Release（别人下载的地方）

1. 先打 tag 并推上去：

   ```powershell
   git tag v1.2.1
   git push origin v1.2.1
   ```

2. 仓库页 → **Releases** → **Draft a new release**
3. Tag：`v1.2.1`；标题：`看小说 1.2.1 —— 人物卡简繁 / 别名去重`
4. 说明贴 `CHANGELOG.md` 里 1.2.1 那段；1.2.0 的功能说明可以附在下面（新装的人看）
5. 附件拖 `dist\aurabot-novel-1.2.1.zip` 上去
6. Publish

> 没有 `gh` CLI，也不要把 token 写进命令历史。要么在网页上点，要么用环境变量里的
> `GH_TOKEN` 调 REST API（token 不要落到仓库 / 日志里）。

历史发布记录（2026-10-29）：

```text
v1.2.0  看小说 1.2.0 —— 支持图片版漫画 PDF
        https://github.com/gchen8102-ops/aurabot-novel/releases/tag/v1.2.0
        附件 aurabot-novel-1.2.0.zip（68,710 B，SHA256 与本地一致）

v1.2.1  人物卡简繁 / 别名去重（本补丁在 1.2.0 发布后修复）
        https://github.com/gchen8102-ops/aurabot-novel/releases/tag/v1.2.1
```

---

## 4. 别人怎么装

```powershell
# 下载 zip 后
Expand-Archive .\aurabot-novel-1.2.1.zip -DestinationPath "$env:USERPROFILE\.dsh\plugins-data\aurabot\modules" -Force
```

目录应该是 `...\modules\novel\index.mjs`。几秒内面板「扩展」页会出现「看小说 / 漫画」并且「已启动」。
升级：删掉 `modules\novel` 再解压新的（书架数据在 `modules-data\novel`，不受影响）。

> 注意：Aurabot 的**扩展模块**不是 DSH 插件，**不能** `dsh plugin add`。
> 它是放在 Aurabot 数据目录 `modules/` 下的文件夹，由 Aurabot 自己加载。

---

## 5. ⭐ 推之前自查（每次都跑）

```powershell
cd C:\Users\陈业昌\Aurabot\qq-chats\novel-mod

# ① 暂存区里有没有书 / 数据 / 包
git diff --cached --name-only | Select-String -Pattern '1\.txt|\.plain\.txt|\.testdata|\.tmpcomic|\.tmpfmt|^dist/|\.bak'

# ② 正文里有没有写死的令牌
git grep --cached -n -E 'Bearer [A-Za-z0-9]{6,}|ONEBOT_TOKEN\s*=\s*["''][^"'']+["'']'

# ③ 该忽略的真的忽略了
git check-ignore -v 1.txt .testdata dist
```

正常结果：① 什么都不输出；② 最多命中注释里的说明；③ 三行规则。

---

## 6. 升版本

1. 改 `index.mjs` 的 `version`
2. 改 `package.json` 的 `version`
3. `CHANGELOG.md` 顶部加一段
4. 新增文件记得加进 `package.json` → `files`（1.2.0 加了 `comic.mjs`）
5. `build.ps1`（版本不一致会直接拦下来；顺手确认 zip 里有新文件）
6. `git tag v1.x.y && git push origin main --tags`，发 Release

---

## 7. 发布前对账

| 项 | 怎么验 |
|---|---|
| 格式解析 | `node test.mjs` → 全部通过（没有样书 / 令牌时显示 SKIP，不算失败） |
| 漫画拆页 | 拿一本真漫画 PDF：`/小说 导入 D:\C7208\妄想学生会\妄想学生会_01.pdf` → 回「漫画 PDF · 156 页」 |
| 漫画阅读 | `/小说 读 书名`（先设小一点：`maxChunks=3`、`comicPages=6`），日志里要出现「认出 N 个人物」「整理出 N 个人物」 |
| 翻页工具 | 面板「扩展」→ 模拟测试 → 调用 `novel_page`，参数 `{"page":154}`，能返回那一页的画面和台词 |
| 真 PDF（文字版） | 拿一本真的 PDF 发给自己：`/小说 导入 D:\books\某本书.pdf`，看抽出来的正文是不是人话 |
| 模块能加载 | 面板「扩展」页「看小说 / 漫画」显示已启动；日志里没有它的报错 |
| zip 内容 | `build.ps1` 输出的文件清单 + 第 1 步的 `-KeepStage` |
| 版本号 | `index.mjs` = `package.json` = zip 文件名 = Release tag |
| 敏感内容 | 第 5 步三条自查 |

1.2.0 实测记录（2026-10-29）：

```text
node test.mjs
→ 全部通过（漫画：识别 / 判图片页 / 导入 / 页索引 / 取 JPEG / PNG 编码；QQ 那几项 SKIP）

/小说 导入 D:\C7208\妄想学生会\妄想学生会_01.pdf
→ 《妄想学生会_01》（漫画 PDF · 156 页）已经放到书架上了

/小说 读 妄想学生会_01     # 每段 6 页，抽 3 段
→ 认出 天草篠 / 男學生；第 1-6、79-84、151-156 页拆出剧情
→ 合并人物卡把「男學生」和「津田隆利」并成一条，最后 2 个人物
```

1.2.1 实测（全 156 页看完）：

```text
/小说 读 妄想学生会_01     # 26 段 × 6 页，全看完
→ status=done pages=156/156
→ 去重前 10 条人物 → 去重后 6 条：天草篠、津田隆利、七条天空、萩村鈴、橫島鳴子、津田琴美
```

---

## 8. 已知限制（写进 Release 说明里，省得被问）

- **看漫画要能看图的模型**：`DeepSeek-V4.1-Flash` 可以；模型不支持视觉、或面板「视觉能力」设成 off 时，她会给明确提示。
- **漫画页图格式**：JPEG（`DCTDecode`）和 Flate 光栅图（转 PNG）支持；JPEG 2000 / CCITT 传真 / JBIG2 的页会跳过并在导入时说明。
- **加密 PDF 读不了**：需要先去掉密码 / 权限保护。
- **少数 PDF 字体没带 ToUnicode**：抽出来会是乱码，会提示转 txt / epub。
- **漫画是抽看的**：默认每段 6 页 × 最多 30 段；156 页会分成 26 段全看，更长的书首段、中间、结尾均匀抽样。
  每段一次视觉调用，会花时间 / 额度。
- **漫画只记原路径**：从书架 / 本地路径导入的不会复制 70MB；原文件被移走或改名后，重发 `/小说 导入` 或放回原处。
- **不支持的格式**：mobi / azw3 / chm / 加密 epub。要读的话先转 epub。
- PDF 抽的是**阅读顺序的文字**，表格 / 公式 / 多栏排版会挤在一起，学角色够用，别当排版工具。
