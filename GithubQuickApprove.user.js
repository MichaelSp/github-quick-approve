// ==UserScript==
// @name        Github Quick Approve
// @icon        https://raw.githubusercontent.com/monodyle/github-quick-approve/main/assets/icons/icon_256.png
// @namespace   https://github.com/monodyle
// @author      monodyle
// @license     MIT
// @version     3.9.2
// @description Quick Approve for Github PR
// @match       https://github.com/*
// @match       https://github.tools.sap/*
// @homepageURL https://github.com/monodyle/github-quick-approve
// @supportURL  https://github.com/monodyle/github-quick-approve/issues
// @downloadURL file:///Users/d067570/src/me/browser-extensions/github-quick-approve/GithubQuickApprove.user.js
// @updateURL   file:///Users/d067570/src/me/browser-extensions/github-quick-approve/GithubQuickApprove.user.js
// ==/UserScript==

// Shared core logic — used by index.js (extension) and GithubQuickApprove.user.js (userscript).

const SCRIPT_VERSION = '3.9.2'


const findButtonByText = (text) =>
  [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text)

const findButtonMatching = (pattern) =>
  [...document.querySelectorAll('button')].find((button) => pattern.test(button.textContent.trim()))

const click = (element) => element?.click()

const retry = (action, attempts = 20, onExhausted) => {
  if (action()) return
  if (--attempts === 0) return onExhausted?.()
  setTimeout(() => retry(action, attempts, onExhausted), 250)
}

const reviewUiDebug = (step) => console.debug(`[Quick Approve v${SCRIPT_VERSION}] native review: ${step}`, {
  buttons: [...document.querySelectorAll('button')].map((button) => ({
    text: button.textContent.trim(), disabled: button.disabled, type: button.type,
  })),
  radios: [...document.querySelectorAll('input[type="radio"], [role="radio"]')].map((input) => ({
    value: input.value, name: input.name, label: input.getAttribute('aria-label'),
  })),
})

const getFetchNonce = () => {
  const meta = document.querySelector('meta[name="fetch-nonce"]')
  return meta ? meta.getAttribute('content') : null
}

// GitHub's current PR page exposes the CSRF token in a meta tag. This works on
// github.com's React UI and GHES; old GHES versions need the /files form fallback.
const getPageCsrfToken = () => {
  const token =
    document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ??
    document.querySelector('input[name="authenticity_token"]')?.value ??
    document.querySelector('input[data-csrf="true"]')?.value ?? null
  return token || null
}

const getReviewFormData = async ({ owner, repo, prNumber, origin }) => {
  // GHES validates the review form's scoped authenticity token; the generic
  // PR-page CSRF meta token is not interchangeable.
  const res = await fetch(`${origin}/${owner}/${repo}/pull/${prNumber}/files`, {
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`files page ${res.status}`)
  const html = await res.text()
  if (/name="pull_request_review\[event\]" value="approve" disabled/.test(html)) {
    throw new Error('not permitted to approve this PR')
  }

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const form = doc.querySelector('form#pull_requests_submit_review')
  const token = form?.querySelector('input[name="authenticity_token"]')?.value ??
    form?.querySelector('input[data-csrf="true"]')?.value ?? getPageCsrfToken()
  console.debug(`[Quick Approve v${SCRIPT_VERSION}] authenticity token source: ${form ? 'review form' : 'PR page'}`)
  return { token, headSha: form?.querySelector('input[name="head_sha"]')?.value ?? null }
}

const setApprovalInProgress = (button = document.getElementById('quick-approve-btn')) => {
  if (!button) return
  if (!document.getElementById('quick-approve-spinner-style')) {
    document.head.insertAdjacentHTML('beforeend', '<style id="quick-approve-spinner-style">@keyframes quick-approve-spin{to{transform:rotate(360deg)}}.quick-approve-spinner{display:inline-block;width:1em;height:1em;margin-left:.35em;vertical-align:-.18em;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:quick-approve-spin .65s linear infinite}</style>')
  }
  button.disabled = true
  button.innerHTML = 'Approving…<span class="quick-approve-spinner" aria-hidden="true"></span>'
  button.setAttribute('aria-busy', 'true')
}

// Fetch-based approval.
// github.com: PUT to the Voltron page_data/submit_review endpoint (JSON, no extra token needed).
// GHES: POST to the legacy HTML /reviews endpoint with the scoped authenticity token.
const submitApprovalViaFetch = async ({ owner, repo, prNumber, origin }) => {
  if (location.hostname === 'github.com') {
    const headSha = getHeadShaFromPage()
    if (!headSha) throw new Error('head_sha not found')

    const res = await fetch(
      `${origin}/${owner}/${repo}/pull/${prNumber}/page_data/submit_review`,
      {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: JSON.stringify({ body: '', event: 'approve', headSha }),
      }
    )
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
    }
  } else {
    // GHES: scoped authenticity token + head_sha from the /files review form.
    const { token, headSha: formSha } = await getReviewFormData({ owner, repo, prNumber, origin })
    const headSha = formSha || getHeadShaFromPage()
    if (!token) throw new Error('could not obtain CSRF token')
    if (!headSha) throw new Error('head_sha not found')

    const res = await fetch(`${origin}/${owner}/${repo}/pull/${prNumber}/reviews`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        '_method': 'put',
        'pull_request_review[event]': 'approve',
        'head_sha': headSha,
        'authenticity_token': token,
      }).toString(),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
    }
  }
}


// Overridable in tests — avoids real navigation and setTimeout races
let navigate = (url) => setTimeout(() => { window.location.href = url }, 800)
const setNavigate = (fn) => { navigate = fn }

const isPullRequestPage = (location = window.location) =>
  /^\/[^/]+\/[^/]+\/pull\/\d+/.test(location.pathname)

// header container selector: github.com (Primer React) + GHES (classic)
const HEADER_ACTIONS_SELECTOR = '.gh-header-actions, [class*="PageHeader-Actions"]:not(.d-none)'

// Read the PR head commit from the rendered page. GHES keeps it in a hidden
// `head_sha` input; GitHub.com may embed it in JSON as `headRefOid`.
const getHeadShaFromPage = () => {
  const sha = '[a-f0-9]{40,64}' // SHA-1 and SHA-256 repositories
  const inputs = document.querySelectorAll('input[name="head_sha"]')
  const hiddenSha = inputs[0]?.value
  if (new RegExp(`^${sha}$`, 'i').test(hiddenSha)) {
    console.debug(`[Quick Approve v${SCRIPT_VERSION}] head_sha source: hidden input`, { count: inputs.length, head_sha: hiddenSha })
    return hiddenSha
  }

  // GHES may render the input inside a component that is unavailable through
  // querySelector at click time. Its serialized page HTML still contains it.
  const html = document.documentElement.innerHTML
  const htmlSha = html.match(new RegExp(`name=["']head_sha["'][^>]*value=["'](${sha})["']`, 'i'))
    ?? html.match(new RegExp(`value=["'](${sha})["'][^>]*name=["']head_sha["']`, 'i'))
  if (htmlSha) {
    console.debug(`[Quick Approve v${SCRIPT_VERSION}] head_sha source: rendered HTML`, { head_sha: htmlSha[1] })
    return htmlSha[1]
  }

  const headOid = new RegExp(`"(?:head_?sha|headRefOid|headCommitOid)"\\s*:\\s*"(${sha})"`, 'i')
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    const m = s.textContent.match(headOid)
    if (m) {
      console.debug(`[Quick Approve v${SCRIPT_VERSION}] head_sha source: page JSON`, { head_sha: m[1] })
      return m[1]
    }
  }
  console.warn(`[Quick Approve v${SCRIPT_VERSION}] no page head_sha found`, {
    hiddenInputCount: inputs.length,
    hiddenInputValue: hiddenSha ?? null,
  })
  return null
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector)
    if (el) return resolve(el)
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector)
      if (el) { observer.disconnect(); resolve(el) }
    })
    observer.observe(document.body, { childList: true, subtree: true })
    setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout waiting for ${selector}`)) }, timeout)
  })
}

// GitHub renders both conditions as page text on GitHub.com and GHES. This
// deliberately blocks on any approval: Quick Approve is for an unreviewed PR.
const getApprovalBlockReason = () => {
  const pageText = document.body.innerText || document.body.textContent || ''
  if (/\bapproved (?:these |the )?changes\b/i.test(pageText)) return 'already approved'
  if (/\b(?:has |with )?conflicts that must be resolved\b|\bmerge conflicts?\b/i.test(pageText)) return 'has merge conflicts'
  return null
}

const insertButton = () => {
  if (!isPullRequestPage()) return

  const prev = document.getElementById('quick-approve-btn')
  if (prev) prev.remove()

  const paths = window.location.pathname.split('/').slice(1, 5)
  const [owner, repo, , prNumber] = paths

  const button = document.createElement('button')
  button.setAttribute('id', 'quick-approve-btn')
  button.dataset.quickApproveVersion = SCRIPT_VERSION
  button.classList.add('btn', 'btn-sm', 'btn-primary')
  button.innerText = 'Quick Approve ✅'
  button.setAttribute('style', 'margin-right: 4px')

  const blockReason = getApprovalBlockReason()
  if (blockReason) {
    button.disabled = true
    button.innerText = `Cannot approve: ${blockReason}`
    button.title = `Quick Approve is disabled: PR ${blockReason}.`
    console.debug(`[Quick Approve v${SCRIPT_VERSION}] disabled`, { reason: blockReason })
  }


  button.addEventListener('click', async (e) => {
    e.preventDefault()
    console.debug(`[Quick Approve v${SCRIPT_VERSION}] click`, { url: location.href })
    const origin = window.location.origin
    try {
      setApprovalInProgress(button)
      await submitApprovalViaFetch({ owner, repo, prNumber, origin })
      button.innerHTML = '✓ Approved'
      button.classList.remove('btn-primary')
      button.classList.add('btn-success')
      button.disabled = true
      navigate(`${origin}/${owner}/${repo}/pulls`)
    } catch (err) {
      console.error(`[Quick Approve v${SCRIPT_VERSION}] error`, err)
      button.innerText = `✗ ${err.message.slice(0, 80)}`
      button.disabled = false
    }
  })

  waitForElement(HEADER_ACTIONS_SELECTOR)
    .then((container) => {
      if (document.getElementById('quick-approve-btn')) return
      container.prepend(button)
    })
    .catch(() => console.warn('Github Quick Approve: could not find header actions container'))
}

// Ctrl+A on a PR page triggers the Quick Approve button
const setupHotkey = () => {
  // Turbo/PJAX navigation calls observeUrlChange repeatedly; install once.
  if (document.documentElement.dataset.quickApproveHotkeySetup) return
  document.documentElement.dataset.quickApproveHotkeySetup = 'true'
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'a' && !e.shiftKey && !e.altKey && !e.metaKey) {
      const btn = document.getElementById('quick-approve-btn')
      if (btn && !btn.disabled) {
        e.preventDefault()
        btn.click()
      }
    }
  })
}

const observeUrlChange = () => {
  console.debug(`[Quick Approve v${SCRIPT_VERSION}] boot`, {
    url: location.href,
    headerActions: document.querySelectorAll(HEADER_ACTIONS_SELECTOR).length,
  })

  let oldHref = document.location.href
  const observer = new MutationObserver(() => {
    if (oldHref !== document.location.href) {
      oldHref = document.location.href
      insertButton()
      return
    }

    // Re-evaluate page state when GitHub dynamically adds a review/conflict.
    // A hot-reloaded extension can also leave an old listener on its button.
    const current = document.getElementById('quick-approve-btn')
    const reason = getApprovalBlockReason()
    if (current && (current.dataset.quickApproveVersion !== SCRIPT_VERSION || current.disabled !== Boolean(reason))) {
      console.debug(`[Quick Approve v${SCRIPT_VERSION}] refreshing button`, {
        staleVersion: current.dataset.quickApproveVersion ?? 'unknown',
        reason,
      })
      insertButton()
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })

  // React may replace the header after userscript injection. Retry briefly,
  // then stop; the navigation observer handles later page changes.
  let attempts = 0
  const insertWhenReady = () => {
    insertButton()
    if (!document.getElementById('quick-approve-btn') && ++attempts < 20) {
      setTimeout(insertWhenReady, 250)
    }
  }
  insertWhenReady()
  setupHotkey()
}


if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', observeUrlChange, { once: true })
} else {
  observeUrlChange()
}
