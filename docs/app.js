(() => {
  const MAX_BYTES = 20 * 1024 * 1024;
  const els = {
    apiBase: document.getElementById('apiBase'),
    saveApi: document.getElementById('saveApi'),
    pdfInput: document.getElementById('pdfInput'),
    pickFile: document.getElementById('pickFile'),
    fileInfo: document.getElementById('fileInfo'),
    recognize: document.getElementById('recognize'),
    clear: document.getElementById('clear'),
    statusCard: document.getElementById('statusCard'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    statusDetail: document.getElementById('statusDetail'),
    resultCard: document.getElementById('resultCard'),
    result: document.getElementById('result'),
    copyResult: document.getElementById('copyResult'),
  };

  let selectedFile = null;
  const savedApi = localStorage.getItem('landApiBase') || '';
  els.apiBase.value = savedApi;

  function normalizeBase(value) {
    return value.trim().replace(/\/+$/, '');
  }

  function setStatus(kind, title, detail = '') {
    els.statusCard.classList.remove('hidden');
    els.statusDot.className = `status-dot ${kind || ''}`.trim();
    els.statusText.textContent = title;
    els.statusDetail.textContent = detail;
  }

  function resetResult() {
    els.resultCard.classList.add('hidden');
    els.result.textContent = '';
  }

  function resetFile() {
    selectedFile = null;
    els.pdfInput.value = '';
    els.fileInfo.classList.add('hidden');
    els.fileInfo.textContent = '';
    els.recognize.disabled = true;
    els.clear.disabled = true;
    els.statusCard.classList.add('hidden');
    resetResult();
  }

  function acceptFile(file) {
    if (!file) return;
    resetResult();
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      resetFile();
      setStatus('error', '檔案格式不符', '請選擇 PDF 檔案。');
      return;
    }
    if (file.size > MAX_BYTES) {
      resetFile();
      setStatus('error', '檔案過大', '測試版僅接受 20MB 以內的 PDF。');
      return;
    }
    selectedFile = file;
    els.fileInfo.textContent = `${file.name}｜${(file.size / 1024 / 1024).toFixed(2)} MB`;
    els.fileInfo.classList.remove('hidden');
    els.recognize.disabled = false;
    els.clear.disabled = false;
    setStatus('', '檔案已選取', '尚未上傳。按「開始辨識」後才會送往你設定的後端 API。');
  }

  els.saveApi.addEventListener('click', () => {
    const base = normalizeBase(els.apiBase.value);
    els.apiBase.value = base;
    localStorage.setItem('landApiBase', base);
    setStatus('ok', 'API 網址已儲存', base || '目前未設定後端 API。');
  });

  els.pickFile.addEventListener('click', () => els.pdfInput.click());
  els.pdfInput.addEventListener('change', event => acceptFile(event.target.files?.[0]));
  els.clear.addEventListener('click', resetFile);

  ['dragenter', 'dragover'].forEach(name => {
    els.pickFile.addEventListener(name, event => {
      event.preventDefault();
      els.pickFile.classList.add('drag');
    });
  });
  ['dragleave', 'drop'].forEach(name => {
    els.pickFile.addEventListener(name, event => {
      event.preventDefault();
      els.pickFile.classList.remove('drag');
    });
  });
  els.pickFile.addEventListener('drop', event => acceptFile(event.dataTransfer?.files?.[0]));

  els.recognize.addEventListener('click', async () => {
    if (!selectedFile) return;
    const base = normalizeBase(els.apiBase.value);
    if (!base) {
      setStatus('error', '尚未設定後端 API', '請先輸入已部署的 HTTPS API 網址。GitHub Pages 本身不能執行 Python 辨識後端。');
      return;
    }

    const form = new FormData();
    form.append('file', selectedFile, selectedFile.name);

    els.recognize.disabled = true;
    resetResult();
    setStatus('working', '辨識中', 'PDF 正在送往後端處理，請勿關閉頁面。');

    try {
      const response = await fetch(`${base}/api/parse`, {
        method: 'POST',
        body: form,
        headers: { 'Accept': 'application/json' },
      });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; }
      catch { data = { raw: text }; }

      if (!response.ok) {
        throw new Error(data?.error || data?.detail || `HTTP ${response.status}`);
      }

      els.result.textContent = JSON.stringify(data, null, 2);
      els.resultCard.classList.remove('hidden');
      setStatus('ok', '辨識完成', '已收到後端回傳結果。');
    } catch (error) {
      setStatus('error', '辨識失敗', error?.message || '無法連線到後端 API。');
    } finally {
      els.recognize.disabled = false;
    }
  });

  els.copyResult.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.result.textContent);
      setStatus('ok', '已複製結果', 'JSON 已複製到剪貼簿。');
    } catch {
      setStatus('error', '複製失敗', '瀏覽器未允許存取剪貼簿。');
    }
  });
})();
