// Minimal Firefox RDP client: list tabs, evaluate JS in a tab.
// Usage: node rdp-probe.mjs <js-file-or-inline-js>
const js = process.argv[2] && process.argv[2] !== '-'
  ? await import('node:fs').then(fs => fs.readFileSync(process.argv[2], 'utf-8'))
  : process.argv.includes('-')
    ? await new Promise(r => { let d = ''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => r(d)); })
    : null

const ws = new WebSocket('ws://127.0.0.1:9223')
let id = 0
const pending = new Map()
const send = (msg) => new Promise((res, rej) => {
  const reqId = ++id
  pending.set(reqId, { res, rej })
  ws.send(JSON.stringify({ ...msg, id: reqId }))
})

const root = await new Promise((res, rej) => {
  ws.onopen = () => {}
  ws.onerror = rej
  ws.onmessage = (e) => { ws.onmessage = null; res(JSON.parse(e.data)) }
})
console.error('[rdp] greeting:', JSON.stringify(root))

// route messages to pending promises
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  const p = pending.get(msg.id)
  if (p) { pending.delete(msg.id); p.res(msg) }
  else if (msg.type === 'console-message') process.stdout.write(`[page-console] ${JSON.stringify(msg)}\n`)
}

const proc = await send({ to: 'root', type: 'getProcess' })
const { tabs } = await send({ to: proc.processActor, type: 'listTabs' })
if (!js) {
  for (const t of tabs) console.log(JSON.stringify({ url: t.url || t.description?.url, title: t.title || t.description?.title, consoleActor: t.consoleActor }))
  process.exit(0)
}

const urlFilter = process.env.TAB_URL
const tab = urlFilter ? tabs.find(t => (t.url || t.description?.url || '').includes(urlFilter)) : tabs[0]
if (!tab) { console.error('no matching tab. set TAB_URL substring'); process.exit(1) }
console.error('[rdp] tab:', tab.url || tab.description?.url)

// attach consoleActor then evaluate
await send({ to: tab.consoleActor, type: 'attach' })
const result = await send({ to: tab.consoleActor, type: 'evaluateJSAsync', text: js })
console.log(JSON.stringify(result.result ?? result, null, 2))
process.exit(0)
