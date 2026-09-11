import express from 'express';
import multer from 'multer';
import { getDocument, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { normalizeTranscriptLabels, parseRealEstateData, toOfflineRows } from './parser-core.mjs';

const app = express();
const port = Number(process.env.PORT || 10000);
const maxBytes = Number(process.env.MAX_FILE_BYTES || 20 * 1024 * 1024);
const maxPages = Number(process.env.MAX_PAGES || 200);
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || 'https://awind74317-spec.github.io').split(',').map(v=>v.trim()).filter(Boolean);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes } });

app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin && allowedOrigins.includes(origin)) res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Accept');
  if(req.method==='OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/',(_,res)=>res.json({ok:true,service:'land-registry-parser',version:'1.0.0-shared-js-core'}));
app.get('/health',(_,res)=>res.json({ok:true,status:'healthy',parser:'shared-js-core'}));

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

app.post('/api/parse',upload.single('file'),async(req,res)=>{
  try{
    if(!req.file) return res.status(400).json({ok:false,error:'未收到 PDF 檔案。'});
    if(!req.file.originalname.toLowerCase().endsWith('.pdf')) return res.status(415).json({ok:false,error:'僅接受 PDF 檔案。'});
    if(req.file.buffer.subarray(0,5).toString()!=='%PDF-') return res.status(400).json({ok:false,error:'檔案不是有效的 PDF。'});

    const pdf=await getDocument({data:new Uint8Array(req.file.buffer),disableWorker:true}).promise;
    try{
      if(pdf.numPages<1) return res.status(400).json({ok:false,error:'PDF 沒有可解析頁面。'});
      if(pdf.numPages>maxPages) return res.status(413).json({ok:false,error:`PDF 超過 ${maxPages} 頁限制。`});
      const pages=[];
      for(let i=1;i<=pdf.numPages;i++){
        const page=await pdf.getPage(i);
        const textContent=await page.getTextContent();
        pages.push([...textContent.items]);
      }
      const text=normalizeTranscriptLabels(composePages(pages));
      const parsed=parseRealEstateData(text,req.file.originalname);
      const rows=toOfflineRows(parsed);
      return res.json({ok:true,parser_version:'1.0.0-shared-js-core',filename:req.file.originalname,page_count:pdf.numPages,file_size:req.file.size,rows,document:{type:parsed.notes.type,main_no:parsed.mainNo,location:parsed.location,address:parsed.notes.address,query_time:parsed.queryTime,source_file:req.file.originalname},warnings:[],privacy:'PDF 僅在本次請求記憶體中處理，API 不主動保存原始檔。'});
    } finally { await pdf.destroy(); }
  } catch(error){
    console.error(error);
    const status=error?.code==='LIMIT_FILE_SIZE'?413:422;
    return res.status(status).json({ok:false,error:status===413?'PDF 超過允許大小。':'PDF 無法解析。'});
  }
});

app.listen(port,'0.0.0.0',()=>console.log(`land-api listening on ${port}`));
