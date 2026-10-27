---
name: 英语校考分析工作台
description: 学习词典第二版：浅灰周边里浮起一块白色大画布，每个考点都是一条词条，长春花紫做词头，玫红只给易错。
colors:
  primary: "#5B57D1"
  primary-hover: "#4B47BC"
  primary-active: "#3E3AA3"
  primary-soft: "#EEEDFB"
  on-primary: "#FFFFFF"
  rose: "#D63B53"
  rose-ink: "#B52A40"
  rose-soft: "rgba(214, 59, 83, 0.08)"
  rose-line: "rgba(214, 59, 83, 0.5)"
  on-rose: "#FFFFFF"
  paper-grey: "#ECECF1"
  canvas-white: "#FFFFFF"
  canvas-tint: "#F6F6FB"
  note-lavender: "#F2F2F9"
  ink: "#1C1B2E"
  ink-2: "#5E5D75"
  placeholder: "#6B6A82"
  line: "#D9D8E6"
  line-strong: "#8D8CA6"
  amber-phonics: "#B98733"
  sage-vocab: "#4C9A74"
  sky-grammar: "#3F86C9"
  teal-communication: "#2C9AA0"
  orchid-reading: "#A062B9"
  terracotta-writing: "#C87B4C"
  night-paper: "#141427"
  night-canvas: "#1D1D35"
  night-canvas-tint: "#23233F"
  night-elevated: "#26264A"
  night-ink: "#ECEBF7"
  night-ink-2: "#A9A8C2"
  night-primary: "#9C98FF"
  night-primary-soft: "#2B2B55"
  night-rose: "#FF7A8C"
typography:
  display:
    fontFamily: "\"Source Sans 3 Variable\", \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", sans-serif"
    fontSize: "44px"
    fontWeight: 700
    lineHeight: 1
  headline:
    fontFamily: "\"Source Sans 3 Variable\", \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.35
  title:
    fontFamily: "\"Source Sans 3 Variable\", \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.25
  lead:
    fontFamily: "\"Source Sans 3 Variable\", \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "\"Source Sans 3 Variable\", \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "\"Source Sans 3 Variable\", \"PingFang SC\", \"Microsoft YaHei\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1
rounded:
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "24px"
  pill: "999px"
spacing:
  "1": "4px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "24px"
  "6": "32px"
  "7": "48px"
  "8": "64px"
components:
  canvas:
    backgroundColor: "{colors.canvas-white}"
    rounded: "{rounded.xl}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
    typography: "{typography.body}"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary}"
  button-quiet:
    textColor: "{colors.primary}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "36px"
  entry-card:
    backgroundColor: "{colors.canvas-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
  entry-card-selected:
    backgroundColor: "{colors.primary-soft}"
  entry-tag:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "24px"
    typography: "{typography.label}"
  entry-tag-mistake:
    backgroundColor: "{colors.rose-soft}"
    textColor: "{colors.rose-ink}"
  usage-note:
    backgroundColor: "{colors.note-lavender}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "16px"
  usage-note-label-mistake:
    backgroundColor: "{colors.rose}"
    textColor: "{colors.on-rose}"
    rounded: "{rounded.pill}"
    height: "24px"
    padding: "0 11px"
  status-label:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 12px"
    height: "26px"
  thumb-tab:
    textColor: "{colors.ink}"
    rounded: "18px 0 0 18px"
    width: "76px"
    padding: "8px 18px 8px 10px"
  nav-link:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.lg}"
    width: "64px"
  nav-link-active:
    backgroundColor: "{colors.canvas-white}"
    textColor: "{colors.ink}"
  panel:
    backgroundColor: "{colors.canvas-white}"
    rounded: "{rounded.lg}"
---

# Design System: 英语校考分析工作台

> 依据构建出来的代码写成（2026-10-27）：`src/renderer/design/tokens.ts`、`design.css`、`page-*.css`、`components/AppLayout.tsx`，以及 `index.html` 里的方向契约（种子 `ba0d512d`，词典方向第二版）。计划文档与代码不一致处，一律以代码为准，并在正文标出。
> 前置 frontmatter 里的颜色都是浅色（词典内页）值；`night-` 开头的是深色（夜读版）里对应的值，完整对照在 `.impeccable/design.json` 的 `colorMeta`。

## Overview

**Creative North Star: "翻开的学习词典"**

每个考点就是一条词条：中文名做词头（长春花紫），下面是白话释义、斜体英文例句、考过几次的小标签、原卷截图缩略。整个应用像一本摊在灰色桌面上的词典：周边是浅灰（#ECECF1），中间浮起一块白色大画布（圆角 24px），左边是只有 84px 宽的图标栏，右边是书口上伸出来的六色拇指索引。对象是不懂语法的运营和辅导老师，所以每一处都先用白话和例句说话，再给数字。

密度是「读得下去」而不是「一屏塞满」：卡片靠 1px 细线和留白分组，不靠阴影，不靠色块；按钮和标签都是胶囊；强调色只有两个，紫色管词头、当前位置和主操作，玫红只管易错。深色是同一本词典的夜读版（深紫靛底，不是纯黑），全部颜色由同一份 tokens 生成。

产品的硬约束（会被投屏、低技术自信、颜色不能是唯一信息载体）已经变成系统规则：正文不小于 14px，颜色旁边一定有字，投屏大字开关把整个界面放大到 115%。

**Key Characteristics:**
- 灰色周边 + 白色大画布 + 84px 窄图标栏：外框一眼就不是后台管理系统。
- 一个主色（长春花紫 #5B57D1）+ 一个警示色（玫红 #D63B53），其余全部是带一点紫调的中性色。
- 卡片是 1px 细线加圆角 18px，不加阴影；阴影只给浮层。
- 英文用 Source Sans 3（含音标、斜体），中文用系统黑体；英文例句一律斜体。
- 浅色和深色两套都是一等公民，所有颜色读自 `--ewb-*` 变量。

## Colors

整体是带紫调的冷中性色，加一个饱和度适中的紫和一个只在出错时出现的玫红；六个大类色降低了饱和度、统一了明度，为的是不抢主色。

### Primary
- **长春花紫** (#5B57D1；hover #4B47BC，active #3E3AA3；浅底 #EEEDFB)：词条的词头、当前导航项的图标、主按钮底色、链接、焦点环、选中行底色（浅底）。在白色画布上对比度 5.6:1。主按钮上的字用白色。深色模式换成 #9C98FF（`night-primary`），按钮上的字取应用底色。

### Secondary
- **易错玫红** (#D63B53；文字版 #B52A40；浅底 8% 透明；细线 50% 透明)：只给易错、失败、需要处理的事项：易错用法框的实心标签、「易错」小标签、失败状态、被标为需要核对的题的底色。小字一律用文字版 #B52A40（玫红本身在浅底上不到 4.5:1）。

### Tertiary（六色拇指索引）
这六个颜色是全局固定的「知识大类」编码，不能挪作他用：
- **琥珀·语音** (#B98733)
- **鼠尾草绿·词汇** (#4C9A74)
- **天蓝·语法** (#3F86C9)
- **青·交际** (#2C9AA0)
- **兰紫·阅读** (#A062B9，听力也归阅读)
- **陶土·写作** (#C87B4C)

每个大类色在 CSS 里展开成三个变量：本色（色条、圆点）、`-soft`（与画布 14% 混合，深色 20%，做标签底和横条轨道）、`-soft-strong`（30% / 38%，选中和悬停）。

### Neutral
- **周边浅灰** (#ECECF1)：应用底色，白色画布浮在它上面。深色 #141427。
- **画布白** (#FFFFFF)：画布、卡片、面板。深色 #1D1D35。
- **画布内第二层** (#F6F6FB)：表头、折叠面板头、说明格、悬停行。深色 #23233F。
- **信息框薰衣草** (#F2F2F9)：用法框、状态「待处理」标签、分段控件轨道。深色 #25254A。
- **正文墨** (#1C1B2E)：正文，带一点紫的近黑；不用纯黑。深色 #ECEBF7。
- **次要文字** (#5E5D75)：说明、标签，在画布上 6.4:1。占位字 #6B6A82。深色 #A9A8C2。
- **细线** (#D9D8E6) 与 **控件描边** (#8D8CA6)：前者分隔卡片和行，后者给输入框、次按钮、标签描边。深色是墨色的 16% / 42% 透明。
- **原卷纸** (#FFFFFF，墨 #1C1B2E)：原卷和页面截图在深色模式下仍是白纸，像书页放在深色布面上。

> 与计划文档不一致，以代码为准：`docs/设计方向-学习词典.md` §八 写的玫红是 #E0445A、深色主色浅底是 #26264A，构建里实际是 #D63B53 和 #2B2B55（#26264A 在代码里是深色浮层底色）。`tokens.ts`、`Basics.tsx` 里个别注释仍沿用第一版措辞（「词头蓝」「圆角 6px」「圆角 8px」），以实际样式为准。

### Named Rules
**The Rose Means Mistake Rule.** 玫红只表示易错、失败和需要处理，从不当装饰色，也不拿来表示「第二强调」。画面上出现玫红，读者就应该知道这里有事要办。

**The Word Beside The Color Rule.** 六个大类色旁边必须有中文名（和数量）；文字永远用墨色，大类色只做色条、圆点、浅底。颜色不是唯一的信息载体。

**The Violet Is The Headword Rule.** 紫色只出现在三类位置：词头和可点的考点名、当前位置（导航、选中行）、每页唯一的主操作。其余强调用墨色加粗。

**The Paper Stays White Rule.** 原卷截图的底永远是白纸，浅色深色都一样；任何叠在原卷上的框（审核页的框选层）使用固定的纸面色，不随主题变。

## Typography

**Display / Body Font:** Source Sans 3 Variable（本地打包，woff2，正体 + 斜体，离线可用），后接 PingFang SC、Microsoft YaHei、Noto Sans CJK SC、Source Han Sans SC、sans-serif
**Label/Mono Font:** 不另设；音标走 `.ewb-ipa`（同为 Source Sans 3，字距 0.01em），因为只有它的 latin-ext 子集能显示 /iː/ 之类的音标

**Character:** 一套无衬线通吃：西文干净、数字等宽，中文用系统黑体而不打包中文字体。计划文档（§八 5）曾考虑换成圆体，最终没换，圆润感由胶囊和大圆角承担。

### Hierarchy
- **Display** (700, 44px, 行高 1)：只用于总览大字结论里的数字，等宽数字，两侧留 0.06em。
- **Headline** (600, 30px, 行高 1.35)：一句话大字结论，最宽 30em；页面标题（试卷库等）同为 30px 但字重 700、行高 1.25。
- **Title** (700, 22px, 行高 1.25)：词条的词头（紫色）、小节标题。紧凑词条降到 18px，详情抽屉里的完整词条升到 30px。
- **Lead** (700 / 400, 16px, 行高 1.5)：面板标题、斜体英文例句（400，斜体）、完整词条里的释义。
- **Body** (400, 14px, 行高 1.6)：正文和 AntD 控件文字。阅读类内容（报告正文）行宽约 44em 到 68em，报告正文放大到 16px、行距 1.85。
- **Label** (600, 13px)：标签、状态、书口索引计数。13px 是下限，系统里没有更小的字号。

### Named Rules
**The 14 Floor Rule.** 正文不小于 14px，最小的辅助字是 13px；要投屏时靠设置里的「投屏大字」整体放大到 115%，而不是在局部放大。

**The Italic Is English Rule.** 斜体只给英文例句和考点里的英文例词。中文标签不用斜体、不加字距、不转大写。

**The Tabular Numbers Rule.** 所有数字（表格、统计、标签、拇指索引计数、书眉）都用等宽数字（`tabular-nums`）。

## Layout

外框是 `.ewb-shell`：灰底铺满视口，左侧 84px 的窄图标栏（`--ewb-sider-w`），右侧是 `.ewb-main`，一块白色画布，圆角 24px，上、右、下各留 16px 灰边（`--ewb-canvas-gap`），左边紧贴侧栏。画布自己滚动，页面不整体滚动。

画布里的内容放在 `.ewb-page` 里：最大宽度 1240px 居中，内边距 24px 32px 48px；阅读类页面（报告、详情）收窄到约 68em 加两侧内边距。页面是容器查询容器（`ewb-page`），响应式靠容器宽度而不是窗口宽度：约 980px 以下，总览的头部从「正文 + 360px 右侧说明」变成单列，书口索引从右侧竖排改为一排横向色块并移到内容上方；约 760px 以上词条才分两栏（栏间 1px 细线，像词典）；约 1040px 以下总览收紧，让首屏先看到词条。审核页是例外，用窗口宽度的媒体查询（1200px、1100px）：三栏（左 260 / 中 自适应 / 右 360），1100px 以下题目列表收进左侧抽屉。

间距阶梯是 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64（`--ewb-sp-1` 到 `-8`）。节奏是：同一张卡片内部 8 到 12px，卡片之间 16px，节与节之间 24 到 32px，小节标题上方的空间大于下方。产品最小窗口约 1100px 宽（审核页支持到约 900px）。

首屏构成（总览）：左侧图标栏；正文顶部是书眉（范围句 + 首词条 — 末词条）和一句大字结论；中部两栏词条；右侧书口索引；主操作「导入试卷」是右上角的紫色胶囊。

> 与计划文档不一致：§八 1 提到「右侧可以留一条窄工具栏放搜索和小部件」，构建里没有这条工具栏。

## Elevation & Depth

系统是平的，靠色阶和细线分层，不靠阴影：灰色周边 → 白色画布 → 卡片（1px 细线）→ 浮层。层级差由「灰底和白画布的明度差」和「1px #D9D8E6 细线」承担；深色模式里同理，画布比应用底色稍亮（#1D1D35 对 #141427）。

### Shadow Vocabulary
- **浮层阴影** (`--ewb-shadow-pop`：`0 10px 28px rgba(28, 27, 46, 0.14)`，深色 `0 10px 28px rgba(0, 0, 0, 0.45)`)：只给下拉、抽屉、对话框、提示气泡、消息条、原卷放大查看。
- **当前导航项的柔影** (`0 6px 16px rgba(28, 27, 46, 0.1)`)：侧栏里当前项（白色圆角底）的柔和阴影，是 §八 2 明确要求的唯一例外；深色模式改成 1px 的细线环。
- **内描边** (`inset 0 0 0 1.5px` 主色或大类色)：选中状态（审核页当前题、报告读者选项）用内环加深，不是阴影。

### Named Rules
**The Hairline, Not Shadow Rule.** 卡片、面板、词条、输入框一律是 1px 细线，圆角 18px，没有阴影；想让东西「浮起来」只能靠它所在的层（画布）。

**The Overlay-Only Shadow Rule.** 阴影等于「这个东西盖在页面上」。没有盖住别的东西的元素不许有阴影（侧栏当前项是唯一的例外）。

## Shapes

形状语言是「书页的圆角 + 胶囊」。大面积的东西圆润（画布 24px、卡片和面板 18px、控件 12px、小块和原卷缩略图 8px），可点的小东西是胶囊（按钮、标签、状态标签、范围条里的小按钮、分段控件，圆角 999px）。

书口拇指索引是系统里唯一的不对称形：只有左侧上下角是 18px 圆角，右侧贴着一条 8px 宽的大类色条，像书页边缘露出的分类标签；选中时整块向左移 6px，色条加宽到 14px。

细线永远是 1px；表格只画横线，不画竖线；虚线边框是有意义的：虚线胶囊表示「估计」「排队中」「样本偏少」，虚线框表示拖放区和可框选的区域。

大类色的小色块用 2px 圆角的方块（词条里的大类标记、色条）或圆点（读者标签、选项），颜色旁边总有字。

### Named Rules
**The Pill For Actions Rule.** 可以点的小控件是胶囊，容器是圆角矩形；不要把按钮做成圆角矩形，也不要把卡片做成胶囊。

## Components

### Buttons
- **Shape:** 全圆角胶囊（999px），高 36px（小号 30px，大号 42px），左右内边距 16px，字重 500，文字 15px。
- **Primary:** 长春花紫实心，白字，每页只放一个。Hover #4B47BC，按下 #3E3AA3；没有阴影。
- **Secondary（默认）:** 透明底，1px 墨色描边（深色模式用 `line-strong`），墨色字；hover 描边和字变紫、底变紫色浅底。
- **Danger:** 玫红描边和字，hover 加玫红浅底；对话框里的实心危险按钮用玫红底、`on-rose` 字（不能是红字红底）。
- **Quiet:** 无边框紫色文字，用于行内次要操作；hover 紫色浅底。
- **规则:** 按钮必须带文字，图标只是陪衬（`Btn` 的 children 必填，没有纯图标写法）；焦点是 2px 紫色外描边、偏移 2px。

### Chips / 标签
- **词条标签 (`ewb-etag`):** 高 24px，胶囊，透明底，1px `line-strong` 描边，13px 600 次要文字色，悬停或键盘聚焦显示白话解释。三个变体：「易错」（玫红文字 + 玫红浅底 + 玫红细线）、「新」（紫色字和描边）、「样本偏少」（墨色字 + 虚线描边）。
- **状态标签 (`ewb-status`):** 高 26px，胶囊，14px。「处理中」紫色描边并带脉动圆点，「待处理」薰衣草底，「已完成」灰线，「排队中」虚线，「失败」玫红字 + 玫红浅底。
- **读者标签 (`ewb-reader`):** 大类色浅底 + 55% 大类色描边 + 大类色圆点，文字墨色。

### Cards / Containers
- **Corner Style:** 卡片、面板、词条标准尺寸 18px。
- **Background:** 白色（画布色）；选中的词条整张换成紫色浅底并把描边换成紫色。
- **Shadow Strategy:** 无，见 Elevation。
- **Border:** 1px `line`。
- **Internal Padding:** 词条标准尺寸 24px，面板 16px，面板头 12px 16px 加下分隔线。
- 面板里嵌套面板（卡中卡）不用；需要分组时用细线分隔或留白。

### Inputs / Fields
- **Style:** AntD 控件按 `antdTheme()` 重染：1px `line-strong` 描边、圆角 12px、高 36px，左右内边距 12px，附加块底色用画布第二层。
- **Focus:** 描边变紫，外加 1px 紫色内阴影（共 2px 的紫色边），不再叠外描边。
- **Error / Disabled:** 错误是玫红描边加 1px 玫红内阴影；表单标签用次要文字色，项间距 20px。

### Navigation（窄图标栏）
- **Style:** 84px 宽、灰底、和画布分开。顶部是产品徽章（盾形里一本翻开的书，线性，紫色，52px）；每项是 22px 线性图标（紫色，lucide，1.75 描边）加下方两个字的 14px 标签（总览 / 试卷 / 队列 / 审核 / 看板 / 报告），底部是设置和外观切换。
- **States:** 默认次要文字色；hover 紫色浅底；当前项是白色圆角（18px）底 + 柔和阴影，文字变墨色，图标加深到 `primary-active`。待办数是图标右上角的紫色小圆角标，带一圈应用底色的 2px 外环。
- **Mobile treatment:** 不适用（桌面应用）。侧栏恒为窄栏，不收起。

### 书口拇指索引（标志组件）
右侧伸出的六个大类标签，每个 76px 宽，最小高 62px，内含 14px 600 的中文名和数量。浅底用大类色 14% 混合，右边缘一条 8px 大类色色条。选中时向左移 6px、底色加深、色条加宽。点它就是「翻到词典的某一节」：内容区横向滑入 240ms，指数缓出（`cubic-bezier(0.16, 1, 0.3, 1)`），这是系统里唯一的标志动效；`prefers-reduced-motion` 下关闭。容器窄于约 980px 时收成一排横向色块，色条改到底部。

### 词条 (Entry)
三种尺寸：紧凑（列表一行一条）、标准（总览用，卡片）、完整（详情抽屉用）。结构固定：紫色词头 → 斜体英文例句 → 标签行（大类、考过几次、易错） → 白话释义 → 例句（英文斜体、中文次要色） → 「出自原卷」缩略图（44px 高，白纸，点开放大） → 底部操作。

### 用法框 (UsageNote)
信息框底色加 1px 细线、圆角 18px，左上角压在边框上的小胶囊标签写明种类：「易错」（玫红实心标签 + 淡玫红底 + 玫红细线）、「辨析」「注意」「提示」（白底 + `line-strong` 描边的标签）。不用左侧粗色条。多条注意会合并成一个可收起的「注意事项（N）」块。

### 范围条 (ScopeBar) 与书眉 (GuideWords)
书眉是一行 14px 次要文字，下方 1px 细线，左边是范围，右边是「首词条 — 末词条」。范围条把筛选写成一句话（「看的是全部 2 份四年级试卷」）加一个紫色「修改范围」，点开才展开筛选面板，默认收起。

### 横条图 (BarList)、热力格 (HeatCell)
横条轨道 12px 高胶囊，轨道用大类色浅底，填充用大类色，旁边是文字标签和数字。热力格是 8px 圆角的浅色格，里面的数字用墨色。

## Do's and Don'ts

### Do:
- **Do** 所有颜色读 `--ewb-*` 变量（由 `tokens.ts` 生成），要加颜色先改 `tokens.ts`，浅色深色同时给。
- **Do** 每个页面只放一个紫色实心主按钮，其余动作用次按钮或安静按钮；按钮永远带文字。
- **Do** 英文例句用斜体，考点名用紫色词头，数字用等宽。
- **Do** 大类色旁边写中文名，文字用墨色。
- **Do** 原卷和页面图用 `PaperSheet` 包住，深色模式里保持白纸。
- **Do** 空状态要教会界面：标题说清这里本该有什么，附步骤和一个主按钮，而不是「暂无数据」。
- **Do** 状态靠文字标签和描边样式（实线、虚线、紫色、玫红）区分，不靠颜色单独承担。

### Don't:
- **Don't** 做成灰底蓝按钮的后台管理系统，或糖果色卡通教育风（产品经用户明确否定）。
- **Don't** 给卡片、面板、输入框加阴影；阴影只属于浮层。
- **Don't** 把玫红用在易错、失败、需要处理以外的地方。
- **Don't** 把大类色当小字的文字色；大类色只做色条、圆点、浅底。
- **Don't** 在新界面里用 `ok` 绿和 `warn` 琥珀（它们只是未迁移的 AntD 控件的兜底，状态改走文字标签）。
- **Don't** 用一排一样大小的数字卡展示统计；总览用一句大字结论，数字写在句子里。
- **Don't** 用图标单独做按钮；设置里的外观切换和侧栏项都带文字。
- **Don't** 在 `tokens.ts` 之外写死颜色值。
- **Don't** 用左侧粗色条标注提示或警告。
