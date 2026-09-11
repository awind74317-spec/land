import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker, PSM } from 'tesseract.js';

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker('chi_tra+eng');
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1'
      });
      return worker;
    })();
  }
  return workerPromise;
}

async function renderPageToPng(page, scale = 2.4) {
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas.toBuffer('image/png');
}

export async function ocrIndexPdf(buffer, options = {}) {
  const maxPages = Number(options.maxPages || 30);
  const scale = Number(options.scale || 2.4);
  const worker = await getWorker();
  const pdf = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
  const pages = [];
  try {
    const count = Math.min(pdf.numPages, maxPages);
    for (let i = 1; i <= count; i++) {
      const page = await pdf.getPage(i);
      const image = await renderPageToPng(page, scale);
      const result = await worker.recognize(image);
      const text = String(result?.data?.text || '').trim();
      pages.push({ page: i, text });
    }
  } finally {
    await pdf.destroy();
  }
  return {
    text: pages.map(p => `${p.text}\n [PAGE_BREAK] \n`).join(''),
    pages,
    pageCount: pages.length
  };
}
