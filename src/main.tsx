import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './modules/App'
import Help from './modules/Help'
function Router(){const [h,setH]=React.useState(window.location.hash);React.useEffect(()=>{const f=()=>setH(window.location.hash);window.addEventListener('hashchange',f);return()=>window.removeEventListener('hashchange',f)},[]);const r=h.replace(/^#/,'');return r.startsWith('/help')? <Help/>:<App/>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Router/></React.StrictMode>)
