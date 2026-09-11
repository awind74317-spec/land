import express from 'express';
import multer from 'multer';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { normalizeTranscriptLabels, parseRealEstateDataList, toOfflineRows } from './parser-core.mjs';
import {
  isChangeIndexText,
  extractNoFromIndex,
  parseChangeIndexData,
  mergeSupplementalIndexRecords,
  extractIndexHolderAnchors,
  reconcileIndexHolders,
  rebuildIndexHistory
} from './index-core.mjs';

const app = express();
const port = Number(process.env.PORT || 10000);
const maxBytes = Number(process.env.MAX_FILE_BYTES || 20 * 1024 * 1024);
const maxPages = Number(process.env.MAX_PAGES || 200);
const maxFiles = Number(process.env.MAX_FILES || 50);
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'https://awind74317-spec.github.io').split(',').map(v=>v.trim()).filter(Boolean);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: maxFiles } });

app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin && allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Accept');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/',(_,res)=>res.json({ok:true,service:'land-registry-parser',version:'1.2.3-elite-parity'}));
app.get('/health',(_,res)=>res.json({ok:true,status:'healthy',parser:'shared-js-core',batch:true,index_matching:true,index_reconcile:true,multi_transcript:true,ocr:false}));

function composePages(pages){
  return pages.map(items=>{
    let text=''; let lastY=null;
    const sorted=[...items].sort((a,b)=>{
      const ay=a.transform?.[5] ?? 0, by=b.transform?.[5] ?? 0;
      if(Math.abs(by-ay)>8) return by-ay;
      return (a.transform?.[4] ?? 0)-(b.transform?.[4] ?? 0);
    });
    for(const item of sorted){
      const y=item.transform?.[5] ?? 0;
      if(lastY!==null && Math.abs(y-lastY)>8) text+='\n';
      else if(text && !text.endsWith('\n')) text+=' ';
      text+=item.str||''; lastY=y;
    }
    return text+'\n [PAGE_BREAK] \n';
  }).join('');
}

function decodeFilename(name=''){
  try{
    if(/[ÃÂåæçä]/.test(name)) return Buffer.from(name,'latin1').toString('utf8');
  } catch {}
  return name;
}

async function extractPdfText(file){
  file.originalname=decodeFilename(file.originalname);
  if(!file.originalname.toLowerCase().endsWith('.pdf')) throw Object.assign(new Error('僅接受 PDF 檔案。'),{status:415});
  if(file.buffer.subarray(0,5).toString()!=='%PDF-') throw Object.assign(new Error('檔案不是有效的 PDF。'),{status:400});
  const pdf=await getDocument({data:new Uint8Array(file.buffer),disableWorker:true}).promise;
  try{
    if(pdf.numPages<1) throw Object.assign(new Error('PDF 沒有可解析頁面。'),{status:400});
    if(pdf.numPages>maxPages) throw Object.assign(new Error(`PDF 超過 ${maxPages} 頁限制。`),{status:413});
    const pages=[];
    for(let i=1;i<=pdf.numPages;i++){
      const page=await pdf.getPage(i);
      const textContent=await page.getTextContent();
      pages.push([...textContent.items]);
    }
    return {text:normalizeTranscriptLabels(composePages(pages)),pageCount:pdf.numPages};
  } finally { await pdf.destroy(); }
}

function normalizePropertyNo(value){ return String(value||'').replace(/\D/g,''); }
function looksLikeIndexOnly(item){
  if(/IDX|異動/i.test(item.file.originalname)) return true;
  const compact=String(item.text||'').replace(/\s+/g,'');
  const indexSignals=(compact.match(/資料項目:|異動別:|異動索引/g)||[]).length;
  const transcriptSignals=(compact.match(/土地登記謄本|建物登記謄本|土地標示部|建物標示部/g)||[]).length;
  return indexSignals>0 && transcriptSignals===0;
}
function rocSortValue(raw=''){
  const m=String(raw).match(/(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if(!m) return 0;
  return Number(m[1])*10000+Number(m[2])*100+Number(m[3]);
}
function latestIndexLabel(records){
  if(!records?.length) return '';
  const latest=[...records].sort((a,b)=>rocSortValue(b.date)-rocSortValue(a.date))[0];
  return latest?.date ? `更新: ${latest.date}` : '';
}

async function parseBatch(files){
  const extracted=[];
  for(const file of files){
    const {text,pageCount}=await extractPdfText(file);
    extracted.push({file,text,pageCount});
  }

  // 1) 先建立異動索引事件池。同一事件若出現在多份索引，先合併可用文字層證據。
  const rawIndexMap=new Map();
  const indexFiles=[];
  for(const item of extracted){
    if(!isChangeIndexText(item.text,item.file.originalname)) continue;
    const propertyNo=extractNoFromIndex(item.text);
    const records=parseChangeIndexData(item.text,{name:item.file.originalname});
    if(propertyNo && records.length){
      const key=normalizePropertyNo(propertyNo);
      if(!rawIndexMap.has(key)) rawIndexMap.set(key,[]);
      rawIndexMap.get(key).push(...records);
    }
    indexFiles.push({filename:item.file.originalname,property_no:propertyNo,record_count:records.length});
  }

  const indexMap=new Map();
  for(const [key,records] of rawIndexMap.entries()) indexMap.set(key,mergeSupplementalIndexRecords(records));

  // 2) 先解析所有謄本，保留其原始文字，供異動索引用「現況謄本錨點」回補。
  const parsedDocs=[];
  for(const item of extracted){
    if(looksLikeIndexOnly(item)) continue;
    const parsedList=parseRealEstateDataList(item.text,item.file.originalname);
    for(const parsed of parsedList){
      parsedDocs.push({item,parsed,key:normalizePropertyNo(parsed.rawBuildNoForLink || parsed.mainNo)});
    }
  }

  // 3) 沿用 Elite 本機版思路：只用可驗證的現況謄本事件錨點補「新增／第一次登記／設定」的權利人。
  //    不猜姓名、不做 OCR；補完後再重建整段歷程，讓後續刪除／清償／資料變更能繼承前一狀態。
  for(const doc of parsedDocs){
    const records=indexMap.get(doc.key);
    if(!records?.length) continue;
    const anchors=extractIndexHolderAnchors(doc.item.text,doc.parsed.notes.type);
    reconcileIndexHolders(records,anchors,doc.parsed.sourceFile || doc.item.file.originalname);
  }
  for(const [key,records] of indexMap.entries()) indexMap.set(key,rebuildIndexHistory(records));

  const rows=[];
  const documents=[];
  const warnings=[];
  for(const doc of parsedDocs){
    const {parsed,key}=doc;
    const fileRows=toOfflineRows(parsed);
    const matched=indexMap.get(key) || [];
    const indexSources=[...new Set(matched.flatMap(r=>r.corroboratingSources?.length?r.corroboratingSources:[r.sourceFile]).filter(Boolean))];
    for(const row of fileRows){
      row.change_index=matched.length?latestIndexLabel(matched):`無關聯索引 (${row.main_no || parsed.mainNo})`;
      row.change_index_count=matched.length;
      row.change_index_records=matched;
      if(indexSources.length) row.source_file += `\n${indexSources.map(name=>`索引: ${name}`).join('\n')}`;
      rows.push(row);
    }
    documents.push({type:parsed.notes.type,main_no:parsed.mainNo,location:parsed.location,address:parsed.notes.address,query_time:parsed.queryTime,source_file:parsed.sourceFile,index_match_count:matched.length});
  }

  if(indexFiles.length && ![...indexMap.values()].some(v=>v.length)) warnings.push('已收到異動索引檔，但未辨識到可配對的地號／建號。');
  const unmatched=indexFiles.filter(info=>info.property_no && !documents.some(doc=>normalizePropertyNo(doc.main_no)===normalizePropertyNo(info.property_no)));
  if(unmatched.length) warnings.push(`有 ${unmatched.length} 份異動索引未找到對應謄本。`);

  const holderConflicts=[];
  for(const records of indexMap.values()) for(const row of records) if(row.holderConflict?.length) holderConflicts.push(row);
  if(holderConflicts.length) warnings.push(`有 ${holderConflicts.length} 筆同一異動事件出現不同權利人文字，已保留首筆並請人工確認。`);

  return {rows,documents,index_files:indexFiles,warnings};
}

app.post('/api/parse',upload.single('file'),async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({ok:false,error:'未收到 PDF 檔案。'});
    const result=await parseBatch([req.file]);
    return res.json({ok:true,parser_version:'1.2.3-elite-parity',filename:decodeFilename(req.file.originalname),file_size:req.file.size,...result,privacy:'PDF 僅在本次請求記憶體中處理，API 不主動保存原始檔。'});
  } catch(error){
    console.error(error);
    const status=error?.status || (error?.code==='LIMIT_FILE_SIZE'?413:422);
    return res.status(status).json({ok:false,error:status===413?'PDF 超過允許大小。':(error?.message||'PDF 無法解析。')});
  }
});

app.post('/api/parse-batch',upload.array('files',maxFiles),async(req,res)=>{
  try{
    const files=req.files || [];
    if(!files.length) return res.status(400).json({ok:false,error:'未收到 PDF 檔案。'});
    const result=await parseBatch(files);
    return res.json({ok:true,parser_version:'1.2.3-elite-parity',file_count:files.length,total_size:files.reduce((s,f)=>s+f.size,0),...result,privacy:'PDF 僅在本次請求記憶體中處理，API 不主動保存原始檔。'});
  } catch(error){
    console.error(error);
    const status=error?.status || (error?.code==='LIMIT_FILE_SIZE'?413:422);
    return res.status(status).json({ok:false,error:status===413?'單一 PDF 超過允許大小。':(error?.message||'PDF 無法解析。')});
  }
});

app.listen(port,'0.0.0.0',()=>console.log(`land-api listening on ${port}`));
