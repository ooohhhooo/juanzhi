/**
 * 内置学校教材目录（每个版本一个 JSON，格式见 src/main/course/textbook.ts 的 CatalogEdition）。
 * 用静态 import 把 JSON 打进主进程的包里（electron-vite 构建时内联），运行时不读磁盘；新增版本：放一个 JSON、在下面加一行。
 * 各版本来源见 docs/学科调研/教材目录/*-调研说明.md。
 */
import mathRenjiao from './math-renjiao.json' with { type: 'json' }
import mathBsd from './math-bsd.json' with { type: 'json' }
import chineseTongbian from './chinese-tongbian.json' with { type: 'json' }
import englishPep from './english-pep.json' with { type: 'json' }
import englishWy from './english-wy.json' with { type: 'json' }
import englishYilin from './english-yilin.json' with { type: 'json' }
import englishBeijing from './english-beijing.json' with { type: 'json' }
import englishBsdsanqi from './english-bsdsanqi.json' with { type: 'json' }
import englishBsdyiqi from './english-bsdyiqi.json' with { type: 'json' }
import englishChongda from './english-chongda.json' with { type: 'json' }
import englishChuanjiao from './english-chuanjiao.json' with { type: 'json' }
import englishDatong from './english-datong.json' with { type: 'json' }
import englishEec from './english-eec.json' with { type: 'json' }
import englishGzjk from './english-gzjk.json' with { type: 'json' }
import englishHjsh from './english-hjsh.json' with { type: 'json' }
import englishHjsq from './english-hjsq.json' with { type: 'json' }
import englishHjyiqi from './english-hjyiqi.json' with { type: 'json' }
import englishJieli from './english-jieli.json' with { type: 'json' }
import englishJjsanqi from './english-jjsanqi.json' with { type: 'json' }
import englishJjyiqi from './english-jjyiqi.json' with { type: 'json' }
import englishJoinin from './english-joinin.json' with { type: 'json' }
import englishKepu from './english-kepu.json' with { type: 'json' }
import englishLiaoshi from './english-liaoshi.json' with { type: 'json' }
import englishLuke from './english-luke.json' with { type: 'json' }
import englishMinjiao from './english-minjiao.json' with { type: 'json' }
import englishPepjt from './english-pepjt.json' with { type: 'json' }
import englishPepxqd from './english-pepxqd.json' with { type: 'json' }
import englishQinghua from './english-qinghua.json' with { type: 'json' }
import englishShanlv from './english-shanlv.json' with { type: 'json' }
import englishWyyiqi from './english-wyyiqi.json' with { type: 'json' }
import englishXianglu from './english-xianglu.json' with { type: 'json' }
import englishXiangshao from './english-xiangshao.json' with { type: 'json' }
import englishXinjiaoji from './english-xinjiaoji.json' with { type: 'json' }
import englishYuejiao from './english-yuejiao.json' with { type: 'json' }

/** 原始 JSON（未校验；校验见 tests/unit/textbook-catalog.test.mjs，用的是 textbook-builtin.ts 的 validateEdition） */
export const CATALOG_RAW: unknown[] = [
  mathRenjiao,
  mathBsd,
  chineseTongbian,
  englishPep,
  englishWy,
  englishYilin,
  englishBeijing,
  englishBsdsanqi,
  englishBsdyiqi,
  englishChongda,
  englishChuanjiao,
  englishDatong,
  englishEec,
  englishGzjk,
  englishHjsh,
  englishHjsq,
  englishHjyiqi,
  englishJieli,
  englishJjsanqi,
  englishJjyiqi,
  englishJoinin,
  englishKepu,
  englishLiaoshi,
  englishLuke,
  englishMinjiao,
  englishPepjt,
  englishPepxqd,
  englishQinghua,
  englishShanlv,
  englishWyyiqi,
  englishXianglu,
  englishXiangshao,
  englishXinjiaoji,
  englishYuejiao,
]
