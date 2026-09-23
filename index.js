const getFetchNonce = () => {
  const meta = document.querySelector('meta[name="fetch-nonce"]')
  return meta ? meta.getAttribute('content') : null
}

const insertButton = () => {
  const prev = document.getElementById('quick-approve-btn')
  if (prev) prev.remove()

  const paths = window.location.pathname.split('/').slice(1, 5)
  console.log('Github Quick Approve', paths.at(-1))
  const [owner, repo, , prNumber] = paths

  const button = document.createElement('button')
  button.setAttribute('id', 'quick-approve-btn')
  button.classList.add('btn', 'btn-sm', 'btn-primary')
  button.innerText = 'Quick Approve'
  button.setAttribute('style', 'margin-right: 4px')

  button.addEventListener('click', async (e) => {
    e.preventDefault()
    button.disabled = true
    button.innerText = 'Approving…'

    try {
      const nonce = getFetchNonce()
      if (!nonce) throw new Error('fetch-nonce not found')

      const prRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
        { headers: { Accept: 'application/vnd.github.v3+json' } }
      )
      const pr = await prRes.json()
      const head_sha = pr.head && pr.head.sha
      if (!head_sha) throw new Error('head_sha not found')

      const body = new URLSearchParams({
        '_method': 'put',
        'pull_request_review[event]': 'approve',
        'head_sha': head_sha,
      })

      const res = await fetch(
        `https://github.com/${owner}/${repo}/pull/${prNumber}/reviews`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Fetch-Nonce': nonce,
            'X-Requested-With': 'XMLHttpRequest',
            'github-verified-fetch': 'true',
          },
          body: body.toString(),
        }
      )

      if (res.ok) {
        button.innerText = '✓ Approved'
        button.classList.remove('btn-primary')
        button.classList.add('btn-success')
      } else {
        throw new Error(`HTTP ${res.status}`)
      }
    } catch (err) {
      console.error('Quick Approve error:', err)
      button.innerText = '✗ Failed'
      button.disabled = false
    }
  })

  // Find the "Code" button (stable sibling) and inject before it
  const codeBtn = [...document.querySelectorAll('button')].find(
    b => b.className.includes('PullRequestCodeButton') ||
         b.textContent.trim() === 'Code'
  )
  if (!codeBtn || !codeBtn.parentElement) {
    console.log('Cannot find Code button container')
    return
  }
  codeBtn.parentElement.insertBefore(button, codeBtn)
}

const observeUrlChange = () => {
  let oldHref = document.location.href
  const observer = new MutationObserver(() => {
    if (oldHref !== document.location.href) {
      oldHref = document.location.href
      if (document.location.pathname.match(/\/pull\/\d+/)) insertButton()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  insertButton()
}

window.onload = observeUrlChange
