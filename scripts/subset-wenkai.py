#!/usr/bin/env python3
"""把霞鹜文楷（OFL-1.1，https://github.com/lxgw/LxgwWenKai）子集化成 woff2，给分享卡片内嵌。
字符集：GB2312 全部汉字（6763）+ ASCII + 全角 / 常用标点 + 少量符号。
用法：python3 scripts/subset-wenkai.py <LXGWWenKai-Medium.ttf> <输出.woff2>   （需要 fonttools 和 brotli）"""
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

src, dst = sys.argv[1], sys.argv[2]
chars = set()
for hi in range(0xB0, 0xF8):
    for lo in range(0xA1, 0xFF):
        try:
            chars.add(bytes([hi, lo]).decode('gb2312'))
        except UnicodeDecodeError:
            pass
chars |= {chr(c) for c in range(0x20, 0x7F)}
chars |= set('，。、；：？！“”‘’（）《》〈〉【】「」『』—…·～→←↑↓✓✗★☆●○■□◆◇＋－×÷＝％℃°¥￥＄')
chars |= {chr(c) for c in range(0xFF01, 0xFF5F)}
opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = ['*']
opts.name_IDs = ['*']
opts.notdef_outline = True
font = TTFont(src)
sub = subset.Subsetter(opts)
sub.populate(text=''.join(sorted(chars)))
sub.subset(font)
font.flavor = 'woff2'
font.save(dst)
print(len(chars), 'chars ->', dst)
