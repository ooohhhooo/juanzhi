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

# 3. docx：文字 + 内嵌图片 / 纯图片 / 带文本框 / 空文档
import io
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = (f'xmlns:w="{W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
      'xmlns:v="urn:schemas-microsoft-com:vml"')

def png_bytes(color):
    b = io.BytesIO(); Image.new('RGB', (120, 120), color).save(b, 'PNG'); return b.getvalue()

DRAWING = ('<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1905000" cy="1905000"/>'
           '<wp:docPr id="1" name="Picture 1" descr="apple"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
           '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="a.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/>'
           '<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="1905000"/></a:xfrm>'
           '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>')

def make_docx(path, body_xml, image_color=None):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        png_default = '<Default Extension="png" ContentType="image/png"/>' if image_color else ''
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + png_default + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        if image_color:
            z.writestr('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>')
            z.writestr('word/media/image1.png', png_bytes(image_color))
        z.writestr('word/document.xml', f'<?xml version="1.0" encoding="UTF-8"?><w:document {NS}><w:body>{body_xml}</w:body></w:document>')

def para(t): return f'<w:p><w:r><w:t>{t}</w:t></w:r></w:p>'
texts = ['四年级英语期末测试卷', 'I. Listen and choose. 听录音，选择正确答案。', '1. How are you? —— I am fine, thank you.']
make_docx(os.path.join(out, 'unit-test.docx'), ''.join(para(t) for t in texts) + DRAWING + para('2. What is this? It is an apple.'), (220, 40, 40))
make_docx(os.path.join(out, 'docx-image-only.docx'), DRAWING, (40, 40, 220))
make_docx(os.path.join(out, 'docx-textbox.docx'), para('正文第一段，有足够多的文字内容用于提取。') + '<w:p><w:r><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>文本框里的文字</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>')
make_docx(os.path.join(out, 'docx-empty.docx'), '<w:p/>')

# 3b. 纯白空白页 PNG（OCR 正常运行但没有文字，用来区分「真没字」与「OCR 没跑成」）
Image.new('RGB', (1190, 1684), 'white').save(os.path.join(out, 'blank-page.png'))

# 3c. 文本层乱码的 PDF：字形名 uniE000.. → pdf.js 读出私有区字符，字数够但不可信
def build_garbled_pdf(path):
    names = ' '.join('/uniE0%02X' % i for i in range(26))
    text = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' * 3
    stream = ('BT /F1 14 Tf 20 250 Td (%s) Tj ET\nBT /F1 14 Tf 20 220 Td (%s) Tj ET' % (text, text)).encode()
    objs = [b'<</Type/Catalog/Pages 2 0 R>>', b'<</Type/Pages/Kids[3 0 R]/Count 1>>',
            b'<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
            b'<</Length %d>>\nstream\n' % len(stream) + stream + b'\nendstream',
            ('<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding<</Type/Encoding/BaseEncoding/WinAnsiEncoding/Differences[65 %s]>>>>' % names).encode()]
    data = b'%PDF-1.4\n'; offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(data)); data += b'%d 0 obj\n' % i + o + b'\nendobj\n'
    x = len(data)
    data += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1) + b''.join(b'%010d 00000 n \n' % o for o in offs)
    data += b'trailer<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, x)
    open(path, 'wb').write(data)
build_garbled_pdf(os.path.join(out, 'garbled-textlayer.pdf'))

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
