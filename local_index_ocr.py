"""Read embedded index-row images with Windows OCR; no network or retained PDFs."""
import json
import subprocess
import uuid
import re
from contextlib import contextmanager
from pathlib import Path

import fitz


@contextmanager
def image_workspace(root):
    work = root / ('index-ocr-' + uuid.uuid4().hex)
    work.mkdir()
    try:
        yield work
    finally:
        for file in work.iterdir():
            file.unlink()
        work.rmdir()


def extract_index_image_lines(pdf_bytes: bytes, base_dir: Path) -> list[dict]:
    work_root = base_dir / 'tmp'
    work_root.mkdir(exist_ok=True)
    with image_workspace(work_root) as folder:
        work = Path(folder)
        manifest, lines = [], []
        with fitz.open(stream=pdf_bytes, filetype='pdf') as document:
            if len(document) > 200:
                raise ValueError('PDF exceeds 200 pages.')
            for page_number, page in enumerate(document):
                for entry in page.get_image_info(xrefs=True):
                    x0, y0, x1, y1 = entry['bbox']
                    # Official index holder/date rows are long horizontal strips.
                    if not entry['xref'] or x1-x0 < 180 or y1-y0 > 45 or entry['width']/max(entry['height'],1) < 8:
                        continue
                    if len(lines) >= 1000:
                        raise ValueError('PDF exceeds 1000 image rows.')
                    image_id = len(lines)
                    image = document.extract_image(entry['xref'])
                    file = work / f'{image_id}.{image["ext"]}'
                    file.write_bytes(image['image'])
                    manifest.append({'id':image_id, 'path':str(file)})
                    lines.append({'page':page_number+1, 'x':x0, 'y':page.rect.height-y1+2})
        if not manifest:
            return []
        def recognize(entries):
            manifest_path = work / 'manifest.json'
            manifest_path.write_text(json.dumps(entries), encoding='utf-8')
            result = subprocess.run(
                ['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(base_dir/'ocr_index_rows.ps1'),'-Manifest',str(manifest_path)],
                capture_output=True, encoding='utf-8', errors='replace', timeout=120,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            if result.returncode:
                raise RuntimeError('Windows OCR failed; verify Traditional Chinese language support.')
            values = json.loads(result.stdout.lstrip('\ufeff'))
            if len(values) != len(entries):
                raise ValueError('OCR returned an incomplete set of image rows.')
            return {str(row['id']): ''.join(row['text'].split()).replace('：', ':').replace('*', '＊') for row in values}

        def holder(text):
            value = text.split('權利人:', 1)[1] if '權利人:' in text else ''
            return value if value and not re.fullmatch(r'[-─_－—.。]+', value) else ''

        results = recognize(manifest)
        retries = []
        missing = [entry for entry in manifest if not holder(results[str(entry['id'])])]
        for entry in missing:
            # Sparse masked surnames may disappear in a very wide line.
            # Retry a padded full line and a padded right half, never guess a name.
            for variant, left_ratio in [('padded', 0), ('right', .45)]:
                source = fitz.Pixmap(fitz.csRGB, fitz.Pixmap(entry['path']))
                left = int(source.width * left_ratio)
                canvas = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, source.width-left+60, source.height+60), False)
                canvas.clear_with(255)
                source.set_origin(30-left, 30)
                canvas.copy(source, canvas.irect)
                retry_id = f'{entry["id"]}-{variant}'
                file = work / f'{retry_id}.png'
                canvas.save(file)
                retries.append({'id':retry_id,'path':str(file)})
        recovered = recognize(retries) if retries else {}
        for entry in manifest:
            image_id = entry['id']
            text = results[str(image_id)]
            if not holder(text):
                candidates = {holder(recovered.get(f'{image_id}-{variant}', '')) for variant in ['padded','right']}
                candidates.discard('')
                if len(candidates) != 1 or '權利人:' not in text:
                    raise ValueError(f'Unresolved holder image on page {lines[image_id]["page"]}; inspect the original PDF.')
                text = text.split('權利人:',1)[0] + '權利人:' + candidates.pop()
            lines[image_id]['text'] = text
        return lines
