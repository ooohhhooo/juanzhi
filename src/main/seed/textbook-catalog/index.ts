/**
 * 内置学校教材目录（每个版本一个 JSON，格式见 src/main/course/textbook.ts 的 CatalogEdition）。
 * 用静态 import 把 JSON 打进主进程的包里（electron-vite 构建时内联），运行时不读磁盘；新增版本：放一个 JSON、在下面加一行。
 */
import mathRenjiao from './math-renjiao.json' with { type: 'json' }
import mathBsd from './math-bsd.json' with { type: 'json' }
import chineseTongbian from './chinese-tongbian.json' with { type: 'json' }
import englishPep from './english-pep.json' with { type: 'json' }
import englishWy from './english-wy.json' with { type: 'json' }
import englishYilin from './english-yilin.json' with { type: 'json' }

/** 原始 JSON（未校验；校验见 tests/unit/textbook-catalog.test.mjs，用的是 textbook.ts 的 validateEdition） */
export const CATALOG_RAW: unknown[] = [mathRenjiao, mathBsd, chineseTongbian, englishPep, englishWy, englishYilin]
