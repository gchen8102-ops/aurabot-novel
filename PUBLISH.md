# 发布攻略（aurabot-novel）

> 对象：Aurabot 扩展模块「看小说」。发出去之后，别人解压到自己的 `modules/` 就能用。
> 跟着抄命令就行，每步都给了验证方法。

---

## 0. 先记住三条：这些**永远不许**进仓库 / 进 zip

| 不许进 | 为什么 | 在哪 |
|---|---|---|
| 任何小说文件（`1.txt`、`.testdata/`） | 是**盗版书**或别人的文稿，传上去就是替别人侵权 | 根目录、`.testdata/` |
| 会话令牌 `ONEBOT_TOKEN` | 等于 QQ 网关的钥匙，拿到的人能冒充你的机器人 | `test.mjs` 已经从代码里删掉，只从环境变量读 |
| `library.json` / `modules-data/` | 里面是**你看过什么书、学的是谁**，属于个人数据 | 不在这个文件夹里，别手动往里拷 |

`.gitignore` 已经拦住了 1、3；第 2 条靠「代码里不写死」。
**每次 push 前跑一遍第 5 步的自查**，别嫌烦。

---

## 1. 打包

```powershell
cd C:\Users\陈业昌\Aurabot\qq-chats\novel-mod
pwsh -File build.ps1
```

会做四件事：

1. 检查 `index.mjs` 和 `package.json` 的版本号是否一致（不一致直接报错）
2. 只把 `package.json` → `files` 里列的运行文件复制进 `dist\stage\novel\`
3. 压成 `dist\aurabot-novel-<版本>.zip`（zip 里有一层 `novel/`，解压到 `modules` 就位）
4. 打印每个文件的大小 + SHA256，并检查包里有没有混进样书 / 备份（有就报错）

验证：

```powershell
pwsh -File build.ps1 -KeepStage       # 留一份解压后的目录
Get-ChildItem dist\stage\novel         # 应该只有 index/ops/store/text/textutil/zip/epub/pdf/learn/style + 文档
```

---

## 2. 建仓库、推上去

```powershell
cd C:\Users\陈业昌\Aurabot\qq-chats\novel-mod
git init -b main
git add -A
git status --short        # ⭐ 眼看一遍：不该有 1.txt / .testdata / dist
git commit -m "feat: 看小说 1.1.0 —— 支持 epub / pdf"
```

在 <https://github.com/new> 建 `aurabot-novel`（建议先 **Private**），然后：

```powershell
git remote add origin https://github.com/gchen8102-ops/aurabot-novel.git
git push -u origin main
```

> 这台机器直连 github.com 不通、`127.0.0.1:7897` 有代理时可以这样配（之前刷抖音插件踩过的坑）：
>
> ```powershell
> git config --global http.https://github.com.proxy http://127.0.0.1:7897
> git config --global http.sslBackend openssl
> ```

`package.json` 里的 `repository` / `homepage` 写的是 `gchen8102-ops/aurabot-novel`，换账号或换仓库名记得一起改。

---

## 3. 发 Release（别人下载的地方）

1. 仓库页 → **Releases** → **Draft a new release**
2. Tag：`v1.1.0`；标题：`看小说 1.1.0 —— 支持 EPUB / PDF`
3. 说明直接贴 `CHANGELOG.md` 里 1.1.0 那段
4. 附件拖 `dist\aurabot-novel-1.1.0.zip` 上去
5. Publish

---

## 4. 别人怎么装

```powershell
# 下载 zip 后
Expand-Archive .\aurabot-novel-1.1.0.zip -DestinationPath "$env:USERPROFILE\.dsh\plugins-data\aurabot\modules" -Force
```

目录应该是 `...\modules\novel\index.mjs`。几秒内面板「扩展」页会出现「看小说」并且「已启动」。
升级：删掉 `modules\novel` 再解压新的（书架数据在 `modules-data\novel`，不受影响）。

> 注意：Aurabot 的**扩展模块**不是 DSH 插件，**不能** `dsh plugin add`。
> 它是放在 Aurabot 数据目录 `modules/` 下的文件夹，由 Aurabot 自己加载。

---

## 5. ⭐ 推之前自查（每次都跑）

```powershell
cd C:\Users\陈业昌\Aurabot\qq-chats\novel-mod

# ① 暂存区里有没有书 / 数据 / 包
git diff --cached --name-only | Select-String -Pattern '1\.txt|\.plain\.txt|\.testdata|\.tmpfmt|^dist/|\.bak'

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
4. `pwsh -File build.ps1`（版本不一致会直接拦下来）
5. `git tag v1.x.y && git push --tags`，发 Release

---

## 7. 发布前对账

| 项 | 怎么验 |
|---|---|
| 格式解析 | `node test.mjs` → 全部通过（没有样书 / 令牌时显示 SKIP，不算失败） |
| 真 PDF | 拿一本真的 PDF 发给自己测一遍：`/小说 导入 D:\books\某本书.pdf`，看抽出来的正文是不是人话 |
| 模块能加载 | 面板「扩展」页「看小说」显示已启动；日志里没有它的报错 |
| zip 内容 | `build.ps1` 输出的文件清单 + 第 1 步的 `-KeepStage` |
| 版本号 | `index.mjs` = `package.json` = zip 文件名 = Release tag |
| 敏感内容 | 第 5 步三条自查 |

---

## 8. 已知限制（写进 Release 说明里，省得被问）

- **扫描版 PDF 读不了**：没有文字层，只能先 OCR。会明确提示，不会静默失败。
- **加密 PDF 读不了**：需要先去掉密码 / 权限保护。
- **少数 PDF 字体没带 ToUnicode**：抽出来会是乱码，会提示转 txt / epub。
- **不支持的格式**：mobi / azw3 / chm / 加密 epub。要读的话先转 epub。
- PDF 抽的是**阅读顺序的文字**，表格 / 公式 / 多栏排版会挤在一起，学角色够用，别当排版工具。
