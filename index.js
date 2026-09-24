import { observeUrlChange } from './core.js'

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', observeUrlChange, { once: true })
} else {
  observeUrlChange()
}
