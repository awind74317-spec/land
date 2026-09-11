import { normalizeTranscriptLabels } from './parser-core.mjs';

function formatDate(raw) {
  if (!raw) return '';
  return String(raw).replace(/年/g, '.').replace(/月/g, '.').replace(/日/g, '');
}

function parseChineseDate(cDate) {
  if (!cDate) return 0;
  let m = String(cDate).trim().match(/^(\d{2,4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (!m) m = String(cDate).trim().match(/^(\d{2,4})年(\d{1,2})月(\d{1,2})日$/);
  if (!m) return 0;
  let year = Number(m[1]);
  if (m[1].length <= 3 || year < 1911) year += 1911;
  const d = new Date(year, Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function isEmptyHolder(value) {
  const v = String(value || '').replace(/[()（）]/g, '').trim();
  return !v || /^(?:空白|無|未載明|-|—|－)$/.test(v);
}

export function isChangeIndexText(text, filename = '') {
  const compact = normalizeTranscriptLabels(text).replace(/\s+/g, '');
  return /異動索引|資料項目:|異動別:/.test(compact) || /IDX/i.test(filename);
}

export function extractNoFromIndex(text) {
  const nText = normalizeTranscriptLabels(text).replace(/[\s\t]/g, '');
  let match = nText.match(/(?:建號|標的|地號|地\/建號)[:：]?(\d{4,5}-\d{3,4})/);
  if (match) return match[1];
  match = nText.match(/(?:建號|地號|地\/建號)[:：]?(\d{8})/);
  if (!match) return '';
  const d = match[1];
  return nText.includes('地號') ? `${d.slice(0,4)}-${d.slice(4)}` : `${d.slice(0,5)}-${d.slice(5)}`;
}

export function parseChangeIndexData(rawText, sourceFile = {}) {
  let cleaned = normalizeTranscriptLabels(rawText)
    .replace(/^\d+\s*\/\s*\d+$/gm, '')
    .replace(/^異動索引.*/gm, '')
    .replace(/本標的面積.*/g, '')
    .replace(/\[PAGE_BREAK\]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/：/g, ':');

  cleaned = cleaned.replace(/(權利人\s*:\s*[^\n]*股份有限公)\s*\n\s*司(?=\s|$)/g, '$1司');
  const blocks = cleaned.split(/(?=資料項目:\s*\d+)/);
  const rawRecords = [];

  for (const block of blocks) {
    if (!block.includes('資料項目')) continue;
    const dateMatch = block.match(/登記日期\s*:?\s*(\d+年\d+月\d+日)/);
    const actionMatch = block.match(/異動別\s*:?\s*(\S+)/);
    const deptMatch = block.match(/部別\s*:?\s*(\S+)/);
    const reasonMatch = block.match(/登記原因\s*:?\s*(\S+)/);
    const orderMatch = block.match(/登記次序\s*:?\s*([^\n]+)/);
    const holderMatch = block.match(/權利人\s*:?\s*([^\n]*)/);
    rawRecords.push({
      date: dateMatch ? dateMatch[1] : '',
      action: actionMatch ? actionMatch[1] : '',
      dept: deptMatch ? deptMatch[1].replace(/^[A-Z]\s+(?=(?:土地|建物))/, '').trim() : '',
      reason: reasonMatch ? reasonMatch[1] : '',
      order: orderMatch ? orderMatch[1].trim() : '(無)',
      rawHolder: holderMatch ? holderMatch[1].trim() : '',
      sequence: (block.match(/序號\s*:\s*(\d+)/) || [])[1] || '',
      receipt: (block.match(/收件字號\s*:\s*(\d+年[^\s]*號)/) || [])[1] || '',
      eventOrdinal: rawRecords.length,
      sourceFile: sourceFile.name || ''
    });
  }

  if (!rawRecords.length) {
    const lines = cleaned.split(/\n/).map(v => v.trim()).filter(Boolean);
    const starts = [];
    lines.forEach((line, i) => { if (/地\s*\/\s*建號\s*:/.test(line)) starts.push(i); });
    starts.forEach((start, idx) => {
      const end = idx + 1 < starts.length ? starts[idx + 1] : Math.min(lines.length, start + 8);
      const block = lines.slice(start, end).join(' ');
      rawRecords.push({
        date: (block.match(/登記日期\S*\s*:\s*(\d+年\d+月\d+日)/) || [])[1] || '',
        action: (block.match(/異動別\s*:\s*([^\s]+)/) || [])[1] || '',
        dept: ((block.match(/部別\s*:\s*(.*?)(?=\s*異動別\s*:|\s*$)/) || [])[1] || '').split(/登記次序\s*:/)[0].trim(),
        reason: (block.match(/登記原因\s*:\s*([^\s]+)/) || [])[1] || '',
        order: (block.match(/登記次序\s*:\s*([^\s]+)/) || [])[1] || '(無)',
        rawHolder: (block.match(/權利人[ \t]*:[ \t]*([^\s]*)/) || [])[1] || '',
        sequence: (block.match(/序號\s*:\s*(\d+)/) || [])[1] || '',
        receipt: (block.match(/收件字號\s*:\s*(\d+年[^\s]*號)/) || [])[1] || '',
        eventOrdinal: rawRecords.length,
        sourceFile: sourceFile.name || ''
      });
    });
  }

  return applyIndexHistory(rawRecords);
}

export function applyIndexHistory(records) {
  const owners = new Map();
  const mortgages = new Map();
  const timeline = [...records].sort((a,b) => parseChineseDate(a.date) - parseChineseDate(b.date) || (a.eventOrdinal||0) - (b.eventOrdinal||0));
  const names = map => [...new Set([...map.values()].filter(Boolean))].join('、') || '未載明';

  for (const row of timeline) {
    const holder = isEmptyHolder(row.rawHolder) ? '' : row.rawHolder;
    const removed = row.action === '刪除' || /清償|塗銷/.test(row.reason || '');
    row.owner = names(owners);
    row.mortgagee = names(mortgages);
    if ((row.dept || '').includes('所有權部')) {
      const known = holder || owners.get(row.order) || '未載明';
      row.owner = known;
      if (removed) { owners.delete(row.order); row.note = '所有權移出'; }
      else { owners.set(row.order, known); row.note = row.action === '新增' || row.action === '第一次登記' ? '所有權取得' : '資料變更'; }
    } else if ((row.dept || '').includes('他項權利部')) {
      const known = holder || mortgages.get(row.order) || '未載明';
      row.mortgagee = known;
      if (removed) { mortgages.delete(row.order); row.note = '抵押權塗銷'; }
      else { mortgages.set(row.order, known); row.note = row.action === '新增' || row.reason === '設定' ? '抵押權設定' : '資料變更'; }
    } else {
      row.note = '標示部異動';
    }
  }
  return records;
}

export function summarizeIndex(records, propertyNo='') {
  if (!records?.length) return propertyNo ? `無關聯索引 (${propertyNo})` : '無關聯索引';
  const sorted = [...records].sort((a,b)=>parseChineseDate(b.date)-parseChineseDate(a.date));
  const latest = sorted[0]?.date ? formatDate(sorted[0].date) : '-';
  return `已配對 ${records.length} 筆｜最新 ${latest}`;
}
