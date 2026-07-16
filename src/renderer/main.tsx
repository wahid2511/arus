import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import CaptureDialog from './CaptureDialog'
import './styles.css'

const view = new URLSearchParams(window.location.search).get('view')
const Root = view === 'capture' ? CaptureDialog : App

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
