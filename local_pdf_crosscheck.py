"""Independent rendered-page OCR. Native PDF text is never an OCR input."""
import json
import subprocess
import fitz
from PIL import Image
from local_index_ocr import image_workspace


def recognize_pages(data, base_dir):
    root = base_dir / 'tmp'
    root.mkdir(exist_ok=True)
    with image_workspace(root) as work, fitz.open(stream=data, filetype='pdf') as doc:
        if len(doc) > 200:
            raise ValueError('Too many pages')
        pages = []
        # One page at a time bounds bitmap memory and leaves no retained document.
        for index, page in enumerate(doc):
            scale = min(3, 2400 / max(page.rect.width, page.rect.height))
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            path = work / 'page.png'
            pix.save(path)
            # A second optical reading only: red-channel filtering suppresses red
            # watermark strokes while retaining neutral black text. Keep the original.
            filtered_path = work / 'page-red-channel.png'
            original = Image.frombytes('RGB', (pix.width, pix.height), pix.samples)
            original.getchannel('R').convert('RGB').save(filtered_path)
            manifest = work / 'manifest.json'
            manifest.write_text(json.dumps([
                {'id': 'original', 'path': str(path), 'detailed': True},
                {'id': 'red-channel', 'path': str(filtered_path), 'detailed': True}
            ]), encoding='utf-8')
            run = subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
                                  str(base_dir / 'ocr_index_rows.ps1'), '-Manifest', str(manifest)],
                                 capture_output=True, encoding='utf-8', check=True, timeout=120,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
            results = {item['id']: item for item in json.loads(run.stdout)}
            def words_for(variant):
                return [{**w, 'x': w['x'] / scale, 'y': w['y'] / scale,
                      'width': w['width'] / scale, 'height': w['height'] / scale}
                     for w in results[variant]['words']]
            pages.append({'page': index + 1, 'words': words_for('original'),
                          'filteredWords': words_for('red-channel'), 'filter': 'red-channel'})
        return pages
