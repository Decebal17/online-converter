import React, { useCallback, useMemo, useState } from "react";
import { zipSync } from "fflate";
import heic2any from "heic2any";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import { PDFDocument } from "pdf-lib";

type ItemStatus = "pending" | "converting" | "done" | "error";
type AudioMode = 'CBR'|'VBR';
type AudioOpts = { mode: AudioMode; kbps: number; vbrq: number; rate: number; ch: 1|2 };
type ImageOpts = { q: number };
type VideoOpts = { crf: number };
type PdfOpts   = { action: 'none'|'split' };

type QItem = {
  id: string; selected: boolean; file: File; target: string; status: ItemStatus;
  outBlob?: Blob; error?: string;
  audio: AudioOpts; image: ImageOpts; video: VideoOpts; pdf: PdfOpts;
};

const IMAGE_TARGETS = ["image/jpeg", "image/png", "image/webp"] as const;
const AUDIO_TARGETS = ["audio/mpeg","audio/aac","audio/ogg","audio/opus","audio/wav"] as const;
const VIDEO_TARGETS = ["video/webm"] as const;

let _ff: FFmpeg | null = null;
async function getFF() { if (!_ff) { _ff = new FFmpeg(); await _ff.load(); } return _ff; }

function human(n: number): string { const u=["B","KB","MB","GB"]; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++} return `${n.toFixed(i?1:0)} ${u[i]}` }
function isHeic(f: File){ const n=f.name.toLowerCase(); return f.type==="image/heic"||f.type==="image/heif"||n.endsWith(".heic")||n.endsWith(".heif") }
function isAudio(f: File){ const n=f.name.toLowerCase(); return f.type.startsWith("audio/")||/\.(mp3|aac|m4a|wav|ogg|opus|flac)$/i.test(n) }
function isVideo(f: File){ const n=f.name.toLowerCase(); return f.type.startsWith("video/")||/\.(mp4|mov|mkv|webm)$/i.test(n) }
function isPDF(f: File){ return f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf") }
function replaceExt(name: string, ext: string){ const i=name.lastIndexOf("."); return (i>=0?name.slice(0,i):name)+ext }

function inferTargets(type: string, name=""): string[] {
  const n = name.toLowerCase();
  if (n.endsWith(".heic")||n.endsWith(".heif")) return ["image/jpeg"];
  if (type.startsWith("image/")) return [...IMAGE_TARGETS];
  if (type.startsWith("audio/")||/\.(mp3|aac|m4a|wav|ogg|opus|flac)$/i.test(n)) return [...AUDIO_TARGETS];
  if (type.startsWith("video/")||/\.(mp4|mov|mkv|webm)$/i.test(n)) return [...VIDEO_TARGETS];
  if (type === "application/pdf" || n.endsWith(".pdf")) return ["application/pdf"];
  return [];
}

async function loadImageBitmap(file: File){ try{ return await createImageBitmap(file) } catch {
  const url = URL.createObjectURL(file); try{
    await new Promise<void>((res,rej)=>{ const img=new Image(); img.onload=()=>res(); img.onerror=rej; img.src=url })
    return await createImageBitmap(file)
  } finally { URL.revokeObjectURL(url) }
}}

async function convertImage(file: File, target: string, qPercent = 90){
  const bmp = await loadImageBitmap(file)
  const canvas = document.createElement("canvas")
  canvas.width = bmp.width; canvas.height = bmp.height
  const ctx = canvas.getContext("2d", { alpha: true })!
  ctx.drawImage(bmp,0,0)
  const q = Math.min(100, Math.max(1, qPercent)) / 100
  return await new Promise<Blob>((ok,err)=>canvas.toBlob(b=>b?ok(b):err(new Error("toBlob failed")), target, q))
}

async function convertAudio(file: File, target: string, opts: AudioOpts){
  const core = await getFF()
  const inName = "in_" + Math.random().toString(36).slice(2)
  await core.writeFile(inName, await fetchFile(file))
  const base = ["-i", inName, "-ar", String(opts.rate), "-ac", String(opts.ch)]
  let out = ""
  if (target==="audio/mpeg"){ out="out.mp3"; if (opts.mode==="VBR") await core.exec([...base,"-c:a","libmp3lame","-q:a",String(opts.vbrq),out]); else await core.exec([...base,"-c:a","libmp3lame","-b:a",`${opts.kbps}k`,out]); }
  else if (target==="audio/aac"){ out="out.m4a"; await core.exec([...base,"-c:a","aac","-b:a",`${opts.kbps}k`,"-f","mp4","-movflags","+faststart",out]); }
  else if (target==="audio/ogg"||target==="audio/opus"){ out=target==="audio/opus"?"out.opus":"out.ogg"; await core.exec([...base,"-c:a","libopus","-b:a",`${opts.kbps}k`,out]); }
  else if (target==="audio/wav"){ out="out.wav"; await core.exec([...base,"-c:a","pcm_s16le",out]); }
  else throw new Error("Unsupported audio target");
  const data = await core.readFile(out)
  try { await core.unlink(inName); await core.unlink(out) } catch {}
  return new Blob([data], { type: target })
}

async function convertVideoToWebM(file: File, crf=33){
  const core = await getFF()
  const inName = "v_in_" + Math.random().toString(36).slice(2)
  const out = "v_out.webm"
  await core.writeFile(inName, await fetchFile(file))
  await core.exec(["-i", inName, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(crf), "-c:a", "libopus", out])
  const data = await core.readFile(out)
  try { await core.unlink(inName); await core.unlink(out) } catch {}
  return new Blob([data], { type: "video/webm" })
}

function TypeBadge({t}:{t:string}){ const label=t? t.split('/')[1]?.toUpperCase():''; return <span className="badge">{label||'FILE'}</span> }

export default function App(){
  const [items, setItems] = useState<QItem[]>([])
  const [drag, setDrag] = useState(false)
  const [progress, setProgress] = useState(0)

  const addFiles = useCallback((files: FileList | File[])=>{
    const list = Array.from(files)
    const mapped: QItem[] = list.map((f, idx)=>{
      const defTarget = inferTargets(f.type, f.name)[0] || "image/webp"
      return { id:`${Date.now()}-${idx}-${Math.random().toString(36).slice(2,8)}`, selected:true, file:f, target:defTarget, status:"pending",
        image:{q:90}, audio:{mode:'CBR',kbps:192,vbrq:2,rate:44100,ch:2}, video:{crf:33}, pdf:{action:'none'} }
    })
    setItems(prev=>[...prev,...mapped])
  },[])

  const onDrop = useCallback((e: React.DragEvent)=>{ e.preventDefault(); setDrag(false); if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files) },[addFiles])
  const onPick = useCallback((e: React.ChangeEvent<HTMLInputElement>)=>{ if(e.target.files?.length) addFiles(e.target.files); e.currentTarget.value="" },[addFiles])

  const selectedCount = useMemo(()=>items.filter(i=>i.selected).length,[items])
  const canConvert = selectedCount>0 && items.some(i=>i.status!=="converting")
  const allChecked = items.length>0 && items.every(i=>i.selected)
  function toggleAll(v:boolean){ setItems(prev=>prev.map(p=>({...p, selected:v}))) }

  const convertAll = useCallback(async ()=>{
    let done=0; setProgress(0); const next=[...items]
    const work = next.filter(it=>it.selected)
    for (let i=0;i<work.length;i++){
      const it = work[i]
      const idx = next.findIndex(n=>n.id===it.id)
      next[idx].status="converting"; setItems([...next])
      try{
        let out: Blob | undefined
        if (isPDF(it.file)) {
          if (it.pdf.action === 'split') {
            next[idx].status = "done"
          } else {
            next[idx].outBlob = new Blob([await it.file.arrayBuffer()], { type: "application/pdf" })
            next[idx].status="done"
          }
        } else if (isHeic(it.file)) {
          const res: any = await heic2any({ blob: it.file, toType: "image/jpeg", quality: 0.92 })
          out = res instanceof Blob ? res : new Blob([res], { type: "image/jpeg" })
          next[idx].target = "image/jpeg"
        } else if (it.file.type.startsWith("image/")) {
          out = await convertImage(it.file, it.target, it.image.q)
        } else if (isAudio(it.file)) {
          out = await convertAudio(it.file, it.target, it.audio)
        } else if (isVideo(it.file)) {
          out = await convertVideoToWebM(it.file, it.video.crf)
          next[idx].target = "video/webm"
        } else {
          throw new Error("Unsupported type")
        }
        if (out) next[idx].outBlob = out
        next[idx].status="done"
      } catch (err:any){ next[idx].status="error"; next[idx].error = err?.message || String(err) }
      done++; setProgress(Math.round(done/work.length*100)); setItems([...next])
    }
  },[items])

  const clearAll = useCallback(()=>{ setItems([]); setProgress(0) },[])

  const downloadZip = useCallback(async ()=>{
    const files: Record<string, Uint8Array> = {}
    for (const it of items){
      if (!it.selected) continue
      if (it.status==="done" && it.outBlob){
        let ext = ".bin"
        if (it.target==="image/jpeg") ext=".jpg"
        if (it.target==="image/png")  ext=".png"
        if (it.target==="image/webp") ext=".webp"
        if (it.target==="audio/mpeg") ext=".mp3"
        if (it.target==="audio/aac")  ext=".m4a"
        if (it.target==="audio/ogg")  ext=".ogg"
        if (it.target==="audio/opus") ext=".opus"
        if (it.target==="audio/wav")  ext=".wav"
        if (it.target==="video/webm") ext=".webm"
        if (it.target==="application/pdf") ext=".pdf"
        const rel = (it.file as any).webkitRelativePath || it.file.name
        const name = replaceExt(rel, ext)
        const buf = new Uint8Array(await it.outBlob.arrayBuffer())
        files[name] = buf
      }
      if (isPDF(it.file) && it.pdf.action==='split') {
        const src = await PDFDocument.load(await it.file.arrayBuffer())
        for (let i=0;i<src.getPageCount();i++){
          const doc = await PDFDocument.create()
          const [page] = await doc.copyPages(src, [i])
          doc.addPage(page)
          const bytes = await doc.save()
          const name = replaceExt(it.file.name, `-page-${i+1}.pdf`)
          files[name] = new Uint8Array(bytes)
        }
      }
    }
    if (!Object.keys(files).length) return
    const zipped = zipSync(files, { level: 6 })
    const blob = new Blob([zipped], { type: "application/zip" })
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "converted.zip"
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href)
  },[items])

  function ItemSettings({it}:{it:QItem}){
    const isImg = it.target.startsWith('image/')
    const isAud = it.target.startsWith('audio/')
    const isVid = it.target.startsWith('video/')
    const isPdf = it.target === 'application/pdf'
    return (
      <div className="row-controls">
        {isImg && (<label className="mini field-inline">Q
          <input type="range" min={1} max={100} value={it.image.q}
            onChange={e=>{const v=parseInt(e.target.value,10); setItems(prev=>prev.map(p=>p.id===it.id?{...p, image:{...p.image, q:v}}:p))}}/>
          <span>{it.image.q}</span></label>)}
        {isAud && (<>
          <label className="mini field-inline">Mode
            <select value={it.audio.mode} onChange={e=>{const v=e.target.value as AudioMode; setItems(prev=>prev.map(p=>p.id===it.id?{...p, audio:{...p.audio, mode:v}}:p))}}>
              <option value="CBR">CBR</option><option value="VBR">VBR (MP3)</option>
            </select>
          </label>
          <label className="mini field-inline">Kbps
            <select value={it.audio.kbps} onChange={e=>{const v=parseInt(e.target.value,10); setItems(prev=>prev.map(p=>p.id===it.id?{...p, audio:{...p.audio, kbps:v}}:p))}} disabled={it.target==='audio/wav' || it.audio.mode==='VBR'}>
              {[96,128,160,192,256,320].map(k=><option key={k} value={k}>{k}</option>)}
            </select>
          </label>
          <label className="mini field-inline">VBR-Q
            <input type="range" min={0} max={9} value={it.audio.vbrq} onChange={e=>{const v=parseInt(e.target.value,10); setItems(prev=>prev.map(p=>p.id===it.id?{...p, audio:{...p.audio, vbrq:v}}:p))}} disabled={it.target!=='audio/mpeg' || it.audio.mode!=='VBR'} />
            <span>{it.audio.vbrq}</span>
          </label>
          <label className="mini field-inline">Rate
            <select value={it.audio.rate} onChange={e=>{const v=parseInt(e.target.value,10); setItems(prev=>prev.map(p=>p.id===it.id?{...p, audio:{...p.audio, rate:v}}:p))}}>
              {[48000,44100,32000,22050,16000].map(r=><option key={r} value={r}>{r/1000}k</option>)}
            </select>
          </label>
          <label className="mini field-inline">Ch
            <select value={it.audio.ch} onChange={e=>{const v=parseInt(e.target.value,10) as 1|2; setItems(prev=>prev.map(p=>p.id===it.id?{...p, audio:{...p.audio, ch:v}}:p))}}>
              <option value={1}>1</option><option value={2}>2</option>
            </select>
          </label>
        </>)}
        {isVid && (<label className="mini field-inline">CRF
          <input type="range" min={18} max={40} value={it.video.crf} onChange={e=>{const v=parseInt(e.target.value,10); setItems(prev=>prev.map(p=>p.id===it.id?{...p, video:{...p.video, crf:v}}:p))}}/>
          <span>{it.video.crf}</span></label>)}
        {isPdf && (<label className="mini field-inline">PDF
          <select value={it.pdf.action} onChange={e=>{const v=e.target.value as 'none'|'split'; setItems(prev=>prev.map(p=>p.id===it.id?{...p, pdf:{...p.pdf, action:v}}:p))}}>
            <option value="none">keep</option><option value="split">split pages</option>
          </select></label>)}
      </div>
    )
  }

  return (<div className="wrap">
    <header className="topbar">
        <div className="brand-row">
          <div className="logo">🔄</div>
          <div className="brand">Clean Converter</div>
        </div>
        <nav><a href="#/help">Help</a></nav>
      </header>

      <section className="hero card">
        <h1 className="hero-title">Privacy-First Online Converter | Image, Audio, Video & PDF</h1>
        <p className="hero-sub">Drag. Drop. Done. Files never leave your device.</p>
      </section>

      <div className="card" style={{marginBottom:12}}>
      <div className={'drop'} onDragOver={e=>{e.preventDefault();}} onDrop={onDrop} onClick={()=>document.getElementById('filepick')?.click()} role="button" tabIndex={0}>
        <div><strong>Drop files here</strong> or click to pick</div>
        <div className="badge" style={{marginTop:8}}>Images · Audio · Video · PDF</div>
      </div>
      <input id="filepick" type="file" multiple webkitdirectory hidden onChange={onPick} />
    </div>
    <div className="card runbar" style={{marginBottom:16}}>
      <div><button className="btn secondary" onClick={()=>{const all = !(items.length>0 && items.every(i=>i.selected)); setItems(prev=>prev.map(p=>({...p, selected:all})))}} disabled={!items.length}>{items.length>0 && items.every(i=>i.selected)?'Unselect all':'Select all'}</button> <span className="mini">{items.filter(i=>i.selected).length} selected</span></div>
      <div><button className="btn secondary" onClick={()=>{setItems([])}} disabled={!items.length}>Clear list</button> <button className="btn" onClick={convertAll} disabled={!(items.filter(i=>i.selected).length>0)}>Convert selected</button> <button className="btn" onClick={downloadZip} disabled={!items.some(i=>i.selected && i.status==='done')}>Download ZIP</button></div>
    </div>
    <div className="card">
      <table><thead><tr><th style={{width:'34px'}}><input type="checkbox" checked={items.length>0 && items.every(i=>i.selected)} onChange={e=>{const v=e.target.checked; setItems(prev=>prev.map(p=>({...p, selected:v})))}}/></th><th style={{width:'40%'}}>File</th><th>Size</th><th>Target</th><th>Settings</th><th>Status</th></tr></thead>
      <tbody>
      {items.map(it=>(<tr key={it.id}>
        <td><input type="checkbox" checked={it.selected} onChange={e=>setItems(prev=>prev.map(p=>p.id===it.id?{...p, selected:e.target.checked}:p))}/></td>
        <td><div className="filecell"><span className="badge">{(it.file.type||'').split('/')[1]?.toUpperCase()||'FILE'}</span>&nbsp;{(it.file as any).webkitRelativePath || it.file.name}</div></td>
        <td>{human(it.file.size)}</td>
        <td><select value={it.target} onChange={e=>{const v=e.target.value; setItems(prev=>prev.map(p=>p.id===it.id?{...p, target:v}:p))}}>{(inferTargets(it.file.type, it.file.name).length? inferTargets(it.file.type, it.file.name) : [...IMAGE_TARGETS,...AUDIO_TARGETS,...VIDEO_TARGETS,"application/pdf"]).map(t=><option key={t} value={t}>{t}</option>)}</select></td>
        <td><ItemSettings it={it} /></td>
        <td>{it.status==="pending"&&<span className="badge">pending</span>}{it.status==="converting"&&<span className="badge">converting…</span>}{it.status==="done"&&<span className="badge">done</span>}{it.status==="error"&&<span className="badge" title={it.error}>error</span>}</td>
      </tr>))}
      {!items.length && <tr><td colSpan={6} style={{color:'#8b93a6'}}>No files yet.</td></tr>}
      </tbody></table>
      <div className="progress" aria-hidden={progress===0}><div className="bar" style={{width: progress + '%'}}/></div>
    </div>
    <footer className="footer">Privacy: files never leave your device.</footer>
  </div>)}
