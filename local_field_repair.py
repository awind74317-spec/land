"""Bounded local OCR of requested abnormal-field rectangles only."""
import json
import subprocess
import fitz
from PIL import Image, ImageOps
from local_index_ocr import image_workspace


def recognize_regions(data, regions, base_dir):
    if not isinstance(regions, list) or not 1 <= len(regions) <= 200:
        raise ValueError('Invalid region count')
    root=base_dir/'tmp';root.mkdir(exist_ok=True)
    with image_workspace(root) as work, fitz.open(stream=data,filetype='pdf') as doc:
        manifest=[]
        seen=set()
        for region in regions:
            ident=region['id'];page_number=region['page']
            if not isinstance(ident,int) or ident in seen or not isinstance(page_number,int) or not 1<=page_number<=len(doc):
                raise ValueError('Invalid region identity')
            seen.add(ident);page=doc[page_number-1];rect=fitz.Rect(region['rect'])
            if rect.is_empty or rect.is_infinite or not page.rect.contains(rect) or rect.width>600 or rect.height>80:
                raise ValueError('Invalid field rectangle')
            scale=min(3,2400/max(page.rect.width,page.rect.height))
            pix=page.get_pixmap(matrix=fitz.Matrix(scale,scale),clip=rect,alpha=False)
            original=Image.frombytes('RGB',(pix.width,pix.height),pix.samples)
            variants={'original':original,'filtered':original.getchannel('R').convert('RGB')}
            for variant,image in variants.items():
                path=work/f'{ident}-{variant}.png'
                image.save(path)
                manifest.append({'id':f'{ident}-{variant}','path':str(path)})
        path=work/'manifest.json';path.write_text(json.dumps(manifest),encoding='utf-8')
        run=subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(base_dir/'ocr_index_rows.ps1'),'-Manifest',str(path)],capture_output=True,encoding='utf-8',check=True,timeout=120,creationflags=subprocess.CREATE_NO_WINDOW)
        output={r['id']:r['text'] for r in json.loads(run.stdout)}
        return [{'id':r['id'],'original':output[f"{r['id']}-original"],'filtered':output[f"{r['id']}-filtered"]} for r in regions]
