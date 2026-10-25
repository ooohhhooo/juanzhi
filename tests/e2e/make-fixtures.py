"""生成 E2E 测试夹具。用法：python3 make-fixtures.py <输出目录> <样本 PNG>"""
import sys, os, zipfile, subprocess
from PIL import Image

out, src = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

# 1. 模拟手机竖拍：像素按横向存储 + EXIF Orientation=6（显示时需顺时针旋转 90°）
img = Image.open(src).convert('RGBA')                # 竖版 1190x1684；样本背景透明，先铺白底
bg = Image.new('RGBA', img.size, 'white'); bg.alpha_composite(img); img = bg.convert('RGB')
stored = img.rotate(90, expand=True)                 # 逆时针 90° 后横向存储 1684x1190
exif = Image.Exif(); exif[0x0112] = 6
stored.save(os.path.join(out, 'phone-exif6.jpg'), quality=92, exif=exif)

# 2. HEIC（用 macOS sips 由 JPG 转换；非 macOS 跳过）
heic = os.path.join(out, 'phone.heic')
r = subprocess.run(['sips', '-s', 'format', 'heic', os.path.join(out, 'phone-exif6.jpg'), '--out', heic],
                   capture_output=True)
if r.returncode != 0 and os.path.exists(heic): os.remove(heic)

# 3. 最小 docx
docx = os.path.join(out, 'unit-test.docx')
with zipfile.ZipFile(docx, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    paras = ['四年级英语期末测试卷', 'I. Listen and choose. 听录音，选择正确答案。', '1. How are you? —— I am fine, thank you.']
    body = ''.join(f'<w:p><w:r><w:t>{p}</w:t></w:r></w:p>' for p in paras)
    z.writestr('word/document.xml', f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>')

# 4. 损坏 PDF、AppleDouble、.doc
open(os.path.join(out, 'corrupt.pdf'), 'wb').write(b'%PDF-1.4\nthis is not a real pdf\n')
open(os.path.join(out, '._junk.pdf'), 'wb').write(b'\x00\x05\x16\x07appledouble')
open(os.path.join(out, 'old-format.doc'), 'wb').write(b'\xd0\xcf\x11\xe0legacy')
print('fixtures ok:', sorted(os.listdir(out)))

# 5. 未内嵌字体、使用预定义 CMap（GBK-EUC-H）的中文 PDF：「测试」= B2E2 CAD4。pdf.js 缺 CMap 时读不出文字
def build_cjk_pdf(path):
    # 8 行 × 8 个「测试」(GBK B2E2CAD4)，共 128 字，超过文本层判定阈值
    rows = b''.join(b'BT /F1 14 Tf 20 %d Td <' % (270 - i * 30) + b'B2E2CAD4' * 8 + b'> Tj ET\n' for i in range(8))
    stream = rows
    objs = [
        b'<</Type/Catalog/Pages 2 0 R>>',
        b'<</Type/Pages/Kids[3 0 R]/Count 1>>',
        b'<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
        b'<</Length %d>>\nstream\n' % len(stream) + stream + b'\nendstream',
        b'<</Type/Font/Subtype/Type0/BaseFont/STSong-Light/Encoding/GBK-EUC-H/DescendantFonts[6 0 R]>>',
        b'<</Type/Font/Subtype/CIDFontType0/BaseFont/STSong-Light/CIDSystemInfo<</Registry(Adobe)/Ordering(GB1)/Supplement 2>>/FontDescriptor 7 0 R/DW 1000>>',
        b'<</Type/FontDescriptor/FontName/STSong-Light/Flags 6/FontBBox[-25 -254 1000 880]/ItalicAngle 0/Ascent 880/Descent -120/CapHeight 700/StemV 80>>',
    ]
    out = b'%PDF-1.4\n'
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % i + o + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)
    for off in offsets:
        out += b'%010d 00000 n \n' % off
    out += b'trailer<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, xref)
    open(path, 'wb').write(out)
build_cjk_pdf(os.path.join(out, 'cjk-nonembedded.pdf'))
