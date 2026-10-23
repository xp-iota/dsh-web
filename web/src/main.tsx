/**
 * main.tsx —— 前端入口。
 *
 * @module dsh-web-ui/main
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('找不到 #root 容器')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
