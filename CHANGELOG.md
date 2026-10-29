# 更新记录

版本号同时写在两处：`index.mjs` 的 `version` 和 `package.json` 的 `version`，发版前对齐。

## 1.1.0

- **新增 EPUB**：按书里的 OPF spine 顺序读，目录页 / 封面 / 注音（ruby）不会混进正文；
  自动用书里写的书名（`dc:title`）；有 DRM 的会直接说读不了，不会读出一堆乱码。
- **新增 PDF**：自带解析器（xref 表、xref 流、对象流 ObjStm、FlateDecode + PNG/TIFF 预测器、
  ASCII85 / ASCIIHex / LZW / RunLength、ToUnicode CMap、Identity-H 复合字体、简单字体的
  WinAnsi / MacRoman / Differences 编码），**不装任何第三方依赖**。
  - 扫描版 / 图片版：提示「先用 OCR 转成文字」，不再默默把空书收进书架。
  - 加密 PDF、字体没有 ToUnicode 的 PDF：给出具体原因和建议。
  - 排版折行按段落拼回去（不是一行一个段落）。
- 书架、导入提示、帮助文字都标出格式（PDF 显示页数，书架列表带 `[PDF]` / `[EPUB]` 标签）。
- 重构：zip 读取独立成 `zip.mjs`；文字工具（解码 / HTML 转文字）独立成 `textutil.mjs`；
  `pdf.mjs`、`epub.mjs` 各自一个文件，`text.mjs` 只做格式分发。
- 测试：新增 EPUB / PDF 用例（含扫描版、DRM、坏文件的降级话术）；
  真网关那几项改成环境变量开关，仓库里不再放会话令牌和样书。

## 1.0.0

- 第一版：txt / docx / 网页导入，书架、分段读、人物卡、学角色、`/小说` 命令与 `novel_*` 工具。
