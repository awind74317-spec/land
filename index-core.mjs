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

function normalizeDept(value) {
  return String(value || '').replace(/^[A-Z]\s+(?=(?:土地|建物))/, '').trim();
}

function eventKey(row) {
  return [row.dept || '', row.order || '', row.date || '', row.reason || '', row.action || '', row.sequence || '', row.receipt || ''].join('|');
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
  const rawRecords = [];
  const blocks = cleaned.split(/(?=資料項目:\s*\d+)/);

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
      dept: normalizeDept(deptMatch ? deptMatch[1] : ''),
      reason: reasonMatch ? reasonMatch[1] : '',
      order: orderMatch ? orderMatch[1].trim() : '(無)',
      rawHolder: holderMatch ? holderMatch[1].trim() : '',
      sequence: (block.match(/序號\s*:\s*(\d+)/) || [])[1] || '',
      receipt: (block.match(/收件字號\s*:\s*(\d+年[^\s]*號)/) || [])[1] || '',
      eventOrdinal: rawRecords.length,
      sourceFile: sourceFile.name || '',
      sourceSection: (cleaned.match(/(?:段小段|地段)\s*:\s*(?:\d+\s+)?([^\s]+)/) || [])[1] || '',
      sourceCity: (cleaned.match(/資料管轄機關\s*:\s*([^\s]+?[縣市])/) || cleaned.match(/縣市\s*:\s*(\S+)/) || [])[1] || ''
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
        dept: normalizeDept(((block.match(/部別\s*:\s*(.*?)(?=\s*異動別\s*:|\s*$)/) || [])[1] || '').split(/登記次序\s*:/)[0].trim()),
        reason: (block.match(/登記原因\s*:\s*([^\s]+)/) || [])[1] || '',
        order: (block.match(/登記次序\s*:\s*([^\s]+)/) || [])[1] || '(無)',
        rawHolder: (block.match(/權利人[ \t]*:[ \t]*([^\s]*)/) || [])[1] || '',
        sequence: (block.match(/序號\s*:\s*(\d+)/) || [])[1] || '',
        receipt: (block.match(/收件字號\s*:\s*(\d+年[^\s]*號)/) || [])[1] || '',
        eventOrdinal: rawRecords.length,
        sourceFile: sourceFile.name || '',
        sourceSection: (cleaned.match(/(?:段小段|地段)\s*:\s*(?:\d+\s+)?([^\s]+)/) || [])[1] || '',
        sourceCity: (cleaned.match(/資料管轄機關\s*:\s*([^\s]+?[縣市])/) || cleaned.match(/縣市\s*:\s*(\S+)/) || [])[1] || ''
      });
    });
  }

  rawRecords.forEach(row => {
    if (row.action === 'T') row.action = '上線轉檔註記';
  });
  return rawRecords;
}

export function mergeSupplementalIndexRecords(records) {
  const groups = new Map();
  for (const row of records || []) {
    const key = eventKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const merged = [];
  for (const group of groups.values()) {
    const primary = {...group[0]};
    const holders = [...new Set(group.filter(r => !isEmptyHolder(r.rawHolder)).map(r => String(r.rawHolder).replace(/\*/g, '＊')))];
    if (holders.length === 1) primary.rawHolder = holders[0];
    if (holders.length > 1) {
      primary.holderConflict = holders;
      primary.rawHolder = holders[0];
    }
    primary.corroboratingSources = [...new Set(group.map(r => r.sourceFile).filter(Boolean))];
    merged.push(primary);
  }
  return merged;
}

export function extractIndexHolderAnchors(text, type) {
  const normalized = normalizeTranscriptLabels(text);
  const anchors = [];
  const pairs = [
    ['所有權部', 'owner', '所有權人'],
    ['他項權利部', 'mortgagee', '權利人']
  ];
  for (const [part, field, label] of pairs) {
    const sectionName = `${type}${part}`;
    let start = normalized.indexOf(sectionName);
    if (start === -1) start = normalized.indexOf(part);
    if (start === -1) continue;
    let end = normalized.length;
    const otherPart = part === '所有權部' ? '他項權利部' : '異動索引';
    const candidates = [normalized.indexOf(`${type}${otherPart}`, start + 1), normalized.indexOf(otherPart, start + 1), normalized.indexOf('異動索引', start + 1)].filter(v => v >= 0);
    if (candidates.length) end = Math.min(...candidates);
    const section = normalized.substring(start, end);
    const entries = section.split(/(?<![\u4e00-\u9fa5])登記次序\s*[:：]/).slice(1);
    for (const entry of entries) {
      const order = entry.match(/^\s*(\d+(?:-\d+)?)/);
      const date = entry.match(/登記日期\s*[:：]\s*(?:民國)?\s*(\d+年\d+月\d+日)/);
      const reason = entry.match(/登記原因\s*[:：]\s*(\S+)/);
      const holder = entry.match(new RegExp(`${label}\\s*[:：]\\s*([^\\s]+)`));
      if (order && date && reason && holder) {
        anchors.push({dept: sectionName, field, order: order[1], date: date[1], reason: reason[1], holder: holder[1]});
      }
    }
  }
  return anchors;
}

export function reconcileIndexHolders(records, anchors, sourceName = '') {
  for (const row of records || []) {
    if (!isEmptyHolder(row.rawHolder)) continue;
    if (!['新增', '第一次登記'].includes(row.action) && row.reason !== '設定') continue;
    const matches = (anchors || []).filter(anchor =>
      anchor.dept === row.dept &&
      anchor.order === row.order &&
      anchor.reason === row.reason &&
      parseChineseDate(anchor.date) === parseChineseDate(row.date)
    );
    if (matches.length !== 1) continue;
    row.rawHolder = matches[0].holder;
    row.anchorHolder = matches[0].holder;
    row.anchorSource = sourceName;
    row.holderEvidence = `現況謄本核對：${sourceName}；${matches[0].dept}；登記次序 ${matches[0].order}；${matches[0].date}`;
  }
  return records;
}

export function applyIndexHistory(records) {
  const owners = new Map();
  const mortgages = new Map();
  const unknown = '未載明';
  const present = value => !isEmptyHolder(value);
  const names = map => [...new Set([...map.values()].map(item => item.name))].join('、') || unknown;
  const evidence = map => [...new Set([...map.values()].map(item => item.evidence).filter(Boolean))].join('；');
  const timeline = [...(records || [])].sort((a,b) => parseChineseDate(a.date) - parseChineseDate(b.date) || (a.eventOrdinal||0) - (b.eventOrdinal||0));

  for (const row of timeline) {
    const holder = row.anchorHolder || row.rawHolder;
    const direct = present(holder);
    const source = row.anchorSource || row.sourceFile || '';
    const proof = source ? `${source}／${row.date}／${row.dept}／${row.order}` : '';
    const removed = row.action === '刪除' || /清償|塗銷/.test(row.reason || '');
    row.owner = names(owners);
    row.mortgagee = names(mortgages);
    const proofs = [evidence(owners), evidence(mortgages)];

    if ((row.dept || '').includes('所有權部')) {
      const known = direct ? {name: holder, evidence: proof} : owners.get(row.order);
      row.owner = known ? known.name : unknown;
      if (known) proofs.push(known.evidence);
      if (removed) {
        row.note = '所有權移出';
        owners.delete(row.order);
      } else {
        if (known) owners.set(row.order, known);
        else if (row.action === '新增' || row.action === '第一次登記') owners.set(row.order, {name: unknown, evidence: ''});
        row.note = row.action === '新增' || row.action === '第一次登記' ? '所有權取得' : '資料變更';
      }
    } else if ((row.dept || '').includes('他項權利部')) {
      const known = direct ? {name: holder, evidence: proof} : mortgages.get(row.order);
      row.mortgagee = known ? known.name : unknown;
      if (known) proofs.push(known.evidence);
      if (removed) {
        row.note = '抵押權塗銷';
        mortgages.delete(row.order);
      } else {
        if (known) mortgages.set(row.order, known);
        else if (row.action === '新增' || row.reason === '設定') mortgages.set(row.order, {name: unknown, evidence: ''});
        row.note = row.action === '新增' || row.reason === '設定' ? '抵押權設定' : '資料變更';
      }
    } else {
      row.note = '標示部異動';
    }
    row.holderEvidence = [...new Set(proofs.filter(Boolean))].join('；');
  }
  return records || [];
}

export function rebuildIndexHistory(records) {
  return applyIndexHistory(records);
}

export function summarizeIndex(records, propertyNo='') {
  if (!records?.length) return propertyNo ? `無關聯索引 (${propertyNo})` : '無關聯索引';
  const sorted = [...records].sort((a,b)=>parseChineseDate(b.date)-parseChineseDate(a.date));
  const latest = sorted[0]?.date ? formatDate(sorted[0].date) : '-';
  return `已配對 ${records.length} 筆｜最新 ${latest}`;
}
