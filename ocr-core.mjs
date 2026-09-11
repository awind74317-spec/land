import { createCanvas } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker, PSM } from 'tesseract.js';

let workerPromise = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // 繁中模型已可辨識一般數字／英文；移除 eng 可降低初始化與辨識成本。
      const worker = await createWorker('chi_tra');
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
        user_defined_dpi: '240'
      });
      return worker;
    })();
  }
  return workerPromise;
}

async function resetWorker() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {}
  workerPromise = null;
}

function withTimeout(promise, ms, label = 'OCR') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function renderPageToPng(page, scale = 1.7) {
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
  const maxPages = Number(options.maxPages || 12);
  const scale = Number(options.scale || 1.7);
  const pageTimeoutMs = Number(options.pageTimeoutMs || 12000);
  const totalTimeoutMs = Number(options.totalTimeoutMs || 55000);
  const startedAt = Date.now();
  const pdf = await getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise;
  const pages = [];
  let timedOut = false;

  try {
    const count = Math.min(pdf.numPages, maxPages);
    for (let i = 1; i <= count; i++) {
      if (Date.now() - startedAt >= totalTimeoutMs) {
        timedOut = true;
        break;
      }

      const page = await pdf.getPage(i);
      const image = await renderPageToPng(page, scale);
      const worker = await getWorker();

      try {
        const result = await withTimeout(worker.recognize(image), pageTimeoutMs, `OCR page ${i}`);
        const text = String(result?.data?.text || '').trim();
        pages.push({ page: i, text });
      } catch (error) {
        if (/timeout/i.test(error?.message || '')) {
          timedOut = true;
          // Tesseract.js 無單頁取消；逾時時終止 worker，避免背景辨識把請求卡住。
          await resetWorker();
          break;
        }
        throw error;
      }
    }
  } finally {
    await pdf.destroy();
  }

  return {
    text: pages.map(p => `${p.text}\n [PAGE_BREAK] \n`).join(''),
    pages,
    pageCount: pages.length,
    timedOut,
    elapsedMs: Date.now() - startedAt
  };
}
