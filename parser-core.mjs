const SHARED_RISK_KEYWORDS = ["流抵", "查封", "限制登記", "套繪", "假扣押", "預告登記", "假處分"];

function normalizeFullWidthDigits(text) {
  return String(text || "").replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

export function normalizeTranscriptLabels(text) {
  let value = normalizeFullWidthDigits(String(text || "").replace(/[\u200b-\u200f\ufeff]/g, "").replace(/[\u00a0\u3000]/g, " "))
    .replace(/[—－–]/g, "-")
    .replace(/他北項權利部/g, "他項權利部")
    .replace(/：/g, ":")
    .replace(/\t/g, " ");
  const labels = [
    "土地登記謄本", "建物登記謄本", "土地標示部", "建物標示部", "標示部",
    "土地所有權部", "建物所有權部", "所有權部", "土地他項權利部", "建物他項權利部", "他項權利部",
    "土地坐落", "建物坐落", "建物門牌", "地上建物", "地號", "建號", "面積", "登記日期", "登記原因",
    "所有權人", "所有權人統一編號", "所有權人證號", "身分證統一編號", "統一編號", "權利範圍", "權利人",
    "權利人統一編號", "權利種類", "共同擔保地號", "共同擔保建號", "擔保債權總金額", "登記次序",
    "使用分區", "使用地類別", "公告土地現值", "公告地價", "主要用途", "主要建材", "主要建築材料",
    "建築完成日期", "總面積", "層數", "層次", "共同使用", "共有部分", "附屬建物"
  ];
  labels.sort((a,b)=>b.length-a.length).forEach(label => {
    const pattern = label.split("").map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
    value = value.replace(new RegExp(pattern, "g"), label);
  });
  return value;
}

function getTranscriptLines(text) {
  return normalizeTranscriptLabels(text).split(/\r?\n/).map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
}
function findFirstIndex(text, keywords, startAt=0) { let best=-1; for (const k of keywords) { const i=text.indexOf(k,startAt); if(i!==-1&&(best===-1||i<best)) best=i; } return best; }
function sliceSection(text, startKeywords, endKeywords) { const start=findFirstIndex(text,startKeywords); if(start===-1) return ""; const end=findFirstIndex(text,endKeywords,start+1); return text.substring(start,end!==-1?end:text.length); }
function normalizeRightsRatio(rawRatio) {
  let ratio=String(rawRatio||"").replace(/[*＊]/g,"").trim(); if(!ratio||ratio==="全部") return "1/1";
  ratio=ratio.replace(/^權利範圍[:：]?/,"").trim();
  let m=ratio.match(/(\d+)\s*分之\s*(\d+)/); if(m) return `${m[2]}/${m[1]}`;
  m=ratio.match(/(\d+)\s*\/\s*(\d+)/); return m?`${m[1]}/${m[2]}`:ratio;
}
function formatLandNo(raw) { const d=String(raw||"").replace(/\D/g,""); return d.length===8?`${d.slice(0,4)}-${d.slice(4)}`:String(raw||"").trim(); }
function formatBuildNo(raw) { const d=String(raw||"").replace(/\D/g,""); return d.length===8?`${d.slice(0,5)}-${d.slice(5)}`:String(raw||"").trim(); }
function formatPropertyNo(raw,isLand){ return isLand?formatLandNo(raw):formatBuildNo(raw); }
function formatDate(raw){ return raw?String(raw).replace(/年/g,".").replace(/月/g,".").replace(/日/g,""):""; }
function getMatchedRiskKeywords(text){ return SHARED_RISK_KEYWORDS.filter(k=>String(text||"").includes(k)); }
function extractAreaNumber(text){ const m=String(text||"").match(/(?:總面積|主建物面積|面積)\s*[:：]?\s*\**\s*([\d,.]+)/); return m?m[1].replace(/,/g,""):""; }
function extractNoFromTranscriptLines(lines,isLand){
  const label=isLand?"地號":"建號";
  for(const line of lines){
    if(!line.includes(label)) continue;
    const m=line.match(isLand?/(\d{4})\s*-\s*(\d{4})/:/(\d{5})\s*-\s*(\d{3})/);
    if(m) return `${m[1]}-${m[2]}`;
    const d=line.match(/(\d{8})/); if(d) return formatPropertyNo(d[1],isLand);
  }
  return "";
}
function extractLocationFromTranscript(streamText){
  const header=streamText.match(/(?:^|\s)([\u4e00-\u9fa5]{1,6}[鄉鎮市區])\s*([\u4e00-\u9fa5A-Za-z0-9]+段(?:[\u4e00-\u9fa5A-Za-z0-9]+小段)?)\s*\d{4,5}-\d{3,4}\s*(?:地號|建號)/);
  if(header){ const authority=streamText.match(/資料管轄機關\s*[:：]\s*([\u4e00-\u9fa5]{2,3}[縣市])/); return {city:authority?authority[1]:"",dist:header[1],section:header[2]}; }
  const cityDist=streamText.match(/([\u4e00-\u9fa5]{2,3}[縣市])\s*([\u4e00-\u9fa5]{1,4}[鄉鎮市區])/);
  const sections=[...streamText.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{1,12}段(?:[\u4e00-\u9fa5A-Za-z0-9]{1,12}小段)?)/g)].map(m=>m[1]).filter(v=>v!=="地段"&&v!=="路段");
  return {city:cityDist?cityDist[1]:"",dist:cityDist?cityDist[2]:"",section:sections[0]||""};
}
function extractParkingDetails(streamText){
  let count=0,totalNum=0,den=0; const h=streamText.match(/車位編號\s+車權利範圍/); if(!h) return {count:"",ratio:""};
  const context=streamText.substring(h.index+h[0].length,h.index+h[0].length+2000);
  let matches=[...context.matchAll(/(地下[^\s]{0,20}|地上[^\s]{0,20}|B\d+[^\s]{0,20}|[一二三四五六七八九十]+層[^\s]{0,20})\s+(\d+)\s*分之\s*(\d+)/g)];
  matches.forEach(m=>{count++; totalNum+=Number(m[3]); den=Number(m[2]);}); return {count:count?String(count):"",ratio:count?`${totalNum}/${den}`:""};
}
function extractAndGroupCollateral(text){
  const officialText=normalizeTranscriptLabels(text);
  if(!/共同擔保(?:地號|建號)\s*:/.test(officialText)) return [];
  const rights=sliceSection(officialText,["土地他項權利部","建物他項權利部","他項權利部"],["異動索引"]);
  return rights.split(/(?<![\u4e00-\u9fa5])登記次序\s*[:：]?/).slice(1).map((entry,index)=>{
    const segments={};
    for(const field of entry.matchAll(/共同擔保(地號|建號)\s*:\s*([\s\S]*?)(?=共同擔保(?:地號|建號)\s*:|其他登記事項\s*:|本謄本|$)/g)){
      let section="";
      for(const token of field[2].matchAll(/([\u4e00-\u9fa5A-Za-z]+段(?:[\u4e00-\u9fa5A-Za-z]+小段)?)|(\d{4,5}-\d{3,4}|\d{8})/g)){
        if(token[1]) { section=token[1]; continue; }
        if(!section) continue;
        if(!segments[section]) segments[section]={地號:[],建號:[]};
        const no=formatPropertyNo(token[2],field[1]==="地號");
        if(!segments[section][field[1]].includes(no)) segments[section][field[1]].push(no);
      }
    }
    const content=Object.keys(segments).sort().map(section=>{
      const lands=segments[section].地號.sort(); const builds=segments[section].建號.sort();
      return section+[lands.length?`地號:${lands.join("、")}`:"",builds.length?`建號:${builds.join("、")}`:""].filter(Boolean).join("、");
    }).join("、");
    return {label:`H${index+1}`,content};
  }).filter(g=>g.content);
}
function extractPureAmounts(streamText){
  const out=[];
  for(const m of streamText.matchAll(/新[台臺]幣[\s*＊]*([0-9,]+)/g)){
    const val=parseInt(m[1].replace(/,/g,""),10); if(!Number.isFinite(val)) continue;
    const formatted=val>=1000?`${Math.round(val/1000).toLocaleString()}仟元`:`${val.toLocaleString()}元`;
    if(!out.includes(formatted)) out.push(formatted);
  }
  return out;
}
function extractOfficialBuildingAreas(streamText){
  const idxMark=findFirstIndex(streamText,["建物標示部","標示部"]); if(idxMark===-1) return null;
  const idxOwnership=findFirstIndex(streamText,["建物所有權部","所有權部"],idxMark);
  const idxCommon=findFirstIndex(streamText,["共同使用","共同使用部分","共有部分"],idxMark);
  const markEnd=idxOwnership!==-1?idxOwnership:streamText.length;
  const mainScopeEnd=idxCommon!==-1&&idxCommon<markEnd?idxCommon:markEnd;
  const mainScope=streamText.substring(idxMark,mainScopeEnd);
  const mainParts=[];
  const mainOnly=mainScope.split(/附屬建物/)[0];
  const total=mainOnly.match(/總面積\s*[:：]?\s*[*＊]*\s*([\d,.]+)\s*平方公尺/);
  const floors=[...mainOnly.matchAll(/層次\s*[:：]\s*(\S+?)\s+層次面積\s*[:：]\s*[*＊]*\s*([\d,.]+)\s*平方公尺/g)];
  if(total) mainParts.push({type:floors.length===1?floors[0][1]:"主建物",area:Number(total[1].replace(/,/g,"")).toFixed(2)});
  else floors.forEach(m=>mainParts.push({type:m[1],area:Number(m[2].replace(/,/g,"")).toFixed(2)}));
  const accStart=mainScope.indexOf("附屬建物");
  if(accStart!==-1){
    const acc=mainScope.substring(accStart);
    for(const m of acc.matchAll(/用途\s*[:：]\s*(\S+?)\s+面積\s*[:：]\s*[*＊]*\s*([\d,.]+)\s*平方公尺/g)) mainParts.push({type:m[1],area:Number(m[2].replace(/,/g,"")).toFixed(2)});
  }
  const publicParts=[];
  if(idxCommon!==-1&&idxCommon<markEnd){
    const common=streamText.substring(idxCommon,markEnd);
    for(const m of common.matchAll(/(\d{5}-\d{3}|\d{8})[\s\S]{0,80}?([\d,.]+)\s*平方公尺[\s\S]{0,120}?(\d+)\s*分之\s*(\d+)/g)){
      const no=formatBuildNo(m[1]); const area=Number(String(m[2]).replace(/,/g,"")); const ratio=`${m[4]}/${m[3]}`;
      if(no&&Number.isFinite(area)&&!publicParts.some(p=>p.no===no)) publicParts.push({no,area,ratio});
    }
  }
  return {mainParts,publicParts};
}

export function isRecognizedTranscriptText(text){
  const compact=normalizeTranscriptLabels(text).replace(/\s+/g,"");
  return compact.includes("土地登記謄本")||compact.includes("建物登記謄本")||compact.includes("土地標示部")||compact.includes("建物標示部")||compact.includes("地號查詢土地資料")||compact.includes("建號查詢建物資料");
}
export function splitOfficialTranscriptText(text){
  const source=normalizeTranscriptLabels(text);
  const starts=[]; const re=/標示部/g; let m;
  while((m=re.exec(source))!==null){
    const pb=source.lastIndexOf("[PAGE_BREAK]",m.index); let s=pb!==-1?pb+"[PAGE_BREAK]".length:Math.max(0,source.lastIndexOf("\n",m.index));
    if(!starts.includes(s)) starts.push(s);
  }
  if(starts.length<=1) return [source];
  const parts=[];
  for(let i=0;i<starts.length;i++){
    const part=source.substring(starts[i],i+1<starts.length?starts[i+1]:source.length).trim();
    if(isRecognizedTranscriptText(part)) parts.push(part);
  }
  return parts.length?parts:[source];
}
export function parseRealEstateDataList(text,filename=""){
  if(!isRecognizedTranscriptText(text)) return [];
  const parts=splitOfficialTranscriptText(text);
  return parts.map((part,index)=>{
    const data=parseRealEstateData(part,filename);
    if(parts.length>1) data.sourceFile=`${filename}#${index+1}`;
    return data;
  }).filter(data=>data&&(data.rawBuildNoForLink||data.owner||data.location));
}

export function parseRealEstateData(text, filename="") {
  const normalizedText=normalizeTranscriptLabels(text); const transcriptLines=getTranscriptLines(text); const compact=normalizedText.replace(/\s+/g,"");
  const isLand=compact.includes("地號查詢土地資料")||compact.includes("土地標示部")||compact.includes("土地登記謄本")||/土地.{0,30}登記謄本/.test(compact);
  const type=isLand?"土地":"建物"; const streamText=normalizedText.replace(/\s+/g," ");
  const ownershipText=sliceSection(streamText,[isLand?"土地所有權部":"建物所有權部","所有權部"],[isLand?"土地他項權利部":"建物他項權利部","他項權利部","異動索引"]);
  const rightsText=sliceSection(streamText,[isLand?"土地他項權利部":"建物他項權利部","他項權利部"],["異動索引"]);
  const result={owner:"",ownerId:"",city:"",dist:"",location:"",mainNo:"",areaA:"0",mainBuildingParts:[],publicParts:[],parkingCount:"",parkingRatio:"",settings:[],notes:{type,dateBuy:"",dateBuild:"",address:"",usage:"",floorInfo:"",parking:"無",material:"",announcedValue:"",announcedPrice:"",regReason:"",unknownRights:"",riskAlerts:""},history:[],pureAmounts:extractPureAmounts(streamText),collateralGroups:extractAndGroupCollateral(text),rawBuildNoForLink:"",queryTime:"-",sourceFile:filename};
  const tm=streamText.match(/資料時間\s*[:：]\s*民國(\d+)年(\d+)月(\d+)日/ )||streamText.match(/(?:列印|核發|謄本列印|資料日期|發給日期)\s*(?:時間|日期)?\s*[:：]?\s*(?:民國)?(\d{2,3})年(\d{1,2})月(\d{1,2})日/);
  if(tm) result.queryTime=`${String(tm[1]).padStart(3,"0")}/${String(tm[2]).padStart(2,"0")}/${String(tm[3]).padStart(2,"0")}`;
  const risks=getMatchedRiskKeywords(streamText); result.notes.riskAlerts=[...new Set(risks.map(r=>r==="流抵"?"出現流抵文字請確認":r))].join("、");
  if(ownershipText){
    let area=ownershipText; const p=ownershipText.indexOf("登記次序"); if(p!==-1) area=ownershipText.substring(p);
    const om=area.match(/所有權人\s*[:]?\s*([^\s:管理者統編]+)/);
    if(om){ const rm=area.match(/權利範圍\s*[:]?\s*([^\s]+)/); result.owner=`${om[1]} (${normalizeRightsRatio(rm?rm[1]:"全部")})`; }
    const id=area.match(/(?:所有權人證號|身分證統一編號|統一編號|所有權人統一編號)\s*[:]?\s*([A-Z0-9*＊Xx]+|\S+)/); if(id) result.ownerId=id[1].replace(/[：:]/g,"").trim();
    const reason=ownershipText.match(/登記原因\s*[:]?\s*([^\s]+)/); if(reason) result.notes.regReason=reason[1];
    const rd=ownershipText.match(/登記日期\s*[:]?\s*(?:民國)?\s*(\d+年\d+月\d+日)/); if(rd) result.notes.dateBuy=formatDate(rd[1]);
  }
  const loc=extractLocationFromTranscript(streamText); result.city=loc.city; result.dist=loc.dist; result.location=`${loc.city}${loc.dist}/${loc.section}`;
  const no=extractNoFromTranscriptLines(transcriptLines,isLand)||((streamText.match(/(\d{4,5}-\d{3,4})/)||[])[1]||""); result.mainNo=no; result.rawBuildNoForLink=no;
  if(isLand){
    const mark=sliceSection(streamText,["土地標示部","標示部"],["所有權部"]); const a=extractAreaNumber(mark);
    if(a){result.areaA=String(Number(a)); result.mainBuildingParts.push({type:"土地",area:result.areaA});}
    const zone=mark.match(/使用分區\s*[:]?\s*(\S+)/); const cls=mark.match(/使用地類別\s*[:]?\s*(\S+)/); result.notes.usage=[zone?`分區:${zone[1].replace(/（空白）/g,"(空白)")}`:"",cls?`類別:${cls[1].replace(/（空白）/g,"(空白)")}`:""].filter(Boolean).join(" ");
    const av=mark.match(/公告(?:土地)?現值\s*[:]?\s*.*?([\d,]+)\s*元/); const ap=mark.match(/公告地價\s*[:]?\s*.*?([\d,]+)\s*元/); if(av)result.notes.announcedValue=av[1]; if(ap)result.notes.announcedPrice=ap[1];
    const gb=streamText.match(/地上建物(?:\(建號\)|建號)?[:：]?\s*共?\s*\d+[筆棟]?\s*([\d\s]+)/); if(gb){const nums=gb[1].match(/\d{8,9}/g)||[]; result.notes.address=nums.map(formatBuildNo).join("、");}
  } else {
    const addr=streamText.match(/建物門牌\s*[:]?\s*([^\s]+)/); if(addr) result.notes.address=addr[1];
    const areas=extractOfficialBuildingAreas(streamText);
    if(areas){
      if(areas.mainParts.length){ result.mainBuildingParts=areas.mainParts; result.areaA=areas.mainParts.reduce((s,p)=>s+(Number(p.area)||0),0).toFixed(2); }
      if(areas.publicParts.length) result.publicParts=areas.publicParts;
    } else {
      const mark=sliceSection(streamText,["建物標示部","標示部"],["所有權部"]); const a=extractAreaNumber(mark); if(a){result.areaA=String(Number(a)); result.mainBuildingParts.push({type:"主建物",area:Number(a).toFixed(2)});}
    }
    const parking=extractParkingDetails(streamText); result.parkingCount=parking.count; result.parkingRatio=parking.ratio;
    const bd=streamText.match(/建築完成日期\s*[:：]?\s*(?:民國)?\s*(\d+年\d+月\d+日)/); if(bd) result.notes.dateBuild=formatDate(bd[1]);
    const material=streamText.match(/主要(?:建築材料|建材)\s*[:：]?\s*([\s\S]*?)\s*(?:總面積|層數|建築完成日期)/); if(material) result.notes.material=material[1].trim().replace(/「/g,"");
    const usage=streamText.match(/主要用途\s*[:：]?\s*([^\s]+)/); if(usage) result.notes.usage=usage[1];
    const floors=streamText.match(/層數\s*[:：]?\s*(\S*?層)/); if(floors) result.notes.floorInfo=floors[1];
    if(result.notes.floorInfo) result.notes.usage=result.notes.usage?`${result.notes.usage}；${result.notes.floorInfo}`:result.notes.floorInfo;
  }
  if(rightsText){
    const entries=rightsText.split(/(?<![\u4e00-\u9fa5])登記次序\s*[:：]?/).slice(1); let h=1;
    for(const entry of entries){
      if(!(entry.includes("抵押權")||entry.includes("最高限額"))) continue;
      const d=entry.match(/登記日期\s*[:]?\s*(?:民國)?\s*(\d+年\d+月\d+日)/);
      const holder=entry.match(/權利人\s*[:]?\s*([^\s:0-9]+?)(?=\s*(?:權利人統一編號|統一編號|住址|債權額|擔保債權|權利範圍|設定|$))/);
      const amt=entry.match(/(?:擔保債權總金額|債權額比例|最高限額|債權額).*?新[台臺]幣[\s*＊]*([0-9,]+)/);
      if(d){
        const raw=amt?parseInt(amt[1].replace(/,/g,""),10):0; const display=raw?`${Math.round(raw/1000).toLocaleString()}仟元`:"";
        const cg=result.collateralGroups.find(g=>g.label===`H${h}`);
        result.settings.push(`H${h}-${formatDate(d[1])} ${holder?holder[1]:"未知"}${display?` ${display}`:""}${cg?` (共擔: ${cg.content})`:""}`.trim()); h++;
      }
    }
  }
  return result;
}

function stripHtml(value){ return String(value||"").replace(/<[^>]+>/g,"").replace(/&nbsp;/g," ").trim(); }
export function toOfflineRows(data){
  const om=(data.owner||"").match(/([^(]+)\s*\(([^)]+)\)/); const ownerName=om?om[1].trim():data.owner; const ratio=om?om[2]:"1/1"; let share=1; if(ratio.includes("/")){const[n,d]=ratio.split("/").map(Number); if(d)share=n/d;}
  const shareDisplay=(share*100).toFixed(2)+"%"; const a=Number(data.areaA)||0; const aPing=(a*0.3025); let pub=0;
  for(const p of data.publicParts||[]){const[n,d]=String(p.ratio||"").split("/").map(Number); if(d)pub+=Number(p.area||0)*(n/d);}
  let parking=0; if(data.parkingRatio&&data.parkingRatio.includes("/")){const[n,d]=data.parkingRatio.split("/").map(Number); const target=(data.publicParts||[]).find(p=>Number(String(p.ratio||"").split("/")[1])===d); if(target&&d)parking=Number(target.area||0)*(n/d);}
  const total=a+pub, noCar=total-parking;
  const mainParts=(data.mainBuildingParts||[]).map((p,i)=>`${i+1}. ${p.type}: ${Number(p.area)%1===0?Number(p.area):p.area}m²`).join("\n")||"--";
  const publicParts=(data.publicParts||[]).map((p,i)=>`共有${i+1}: ${Number(p.area).toFixed(2)} m², 持分 ${p.ratio} (建號 ${formatBuildNo(p.no)})`).join("\n")||"--";
  const settings=(data.settings||[]).map(stripHtml).join("\n")||"無"; const pure=(data.pureAmounts||[])[0]||"無"; const collateral=(data.collateralGroups||[]).map(x=>`${x.label} ${x.content}`).join("\n")||"無";
  const notes=[`1.所有權登記日: ${data.notes.dateBuy||"-"}`,`2.完工登記日: ${data.notes.dateBuild||"-"}`,`3.建築類型: ${data.notes.usage||"-"}`,`4.有無車位: ${Number(data.parkingCount||0)>0?"含車位":"無"}`,`5.主要建材: ${data.notes.material||"-"}`,`6.登記原因: ${data.notes.regReason||"-"}`,`7.風險提醒: ${data.notes.riskAlerts||"-"}`].join(" ");
  return [{pre_review_case_no:"-",type:data.notes.type,owner_name:ownerName,owner_id:data.ownerId||"請重新確認",owner_share:shareDisplay,location:data.location,address:data.notes.address||"",main_no:data.mainNo,main_building_parts:mainParts,main_building_m2:a.toFixed(2),main_building_ping:aPing.toFixed(2),public_parts:publicParts,public_m2:pub.toFixed(2),public_ping:(pub*0.3025).toFixed(2),parking_count:data.parkingCount||"-",parking_ratio:data.parkingRatio||"-",parking_m2:parking>0?parking.toFixed(2):"-",parking_ping:parking>0?(parking*0.3025).toFixed(2):"-",total_m2_w_car:total.toFixed(2),total_ping_w_car:(total*0.3025).toFixed(2),total_m2_no_car:noCar.toFixed(2),total_ping_no_car:(noCar*0.3025).toFixed(2),announced_value:data.notes.announcedValue||"-",announced_price:data.notes.announcedPrice||"-",post_share_m2_w_car:(total*share).toFixed(2),post_share_ping_w_car:(total*0.3025*share).toFixed(2),post_share_m2_no_car:(noCar*share).toFixed(2),post_share_ping_no_car:(noCar*0.3025*share).toFixed(2),pure_amount:pure,collateral,settings,notes,change_index:`無關聯索引 (${data.rawBuildNoForLink||data.mainNo})`,query_time:data.queryTime,source_file:`${data.notes.type}: ${data.sourceFile}`,record_time:"-",risk_alerts:data.notes.riskAlerts?data.notes.riskAlerts.split("、"):[]}];
}
