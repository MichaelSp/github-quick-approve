// Shared core logic — used by index.js (extension) and GithubQuickApprove.user.js (userscript).

const SCRIPT_VERSION = '3.7.7'
const GITHUB_REVIEW_FLOW_KEY = 'quickApproveGithubReviewPending'

const findButtonByText = (text) =>
  [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === text)

const findButtonMatching = (pattern) =>
  [...document.querySelectorAll('button')].find((button) => pattern.test(button.textContent.trim()))

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

export const getFetchNonce = () => {
  const meta = document.querySelector('meta[name="fetch-nonce"]')
  return meta ? meta.getAttribute('content') : null
}

// GitHub's current PR page exposes the CSRF token in a meta tag. This works on
// github.com's React UI and GHES; old GHES versions need the /files form fallback.
export const getPageCsrfToken = () => {
  const token =
    document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ??
    document.querySelector('input[name="authenticity_token"]')?.value ??
    document.querySelector('input[data-csrf="true"]')?.value ?? null
  return token || null
}

export const getReviewFormData = async ({ owner, repo, prNumber, origin }) => {
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

// Works on both github.com and GHES (e.g. github.example.com)
// GitHub.com has moved review submission behind its native React dialog.
// Let that dialog submit the review instead of duplicating its private POST.
export const beginGithubApproval = ({ owner, repo, prNumber }) => {
  sessionStorage.setItem(GITHUB_REVIEW_FLOW_KEY, 'true')
  window.location.assign(`/${owner}/${repo}/pull/${prNumber}/changes`)
}

export const resumeGithubApproval = () => {
  if (location.hostname !== 'github.com' || !sessionStorage.getItem(GITHUB_REVIEW_FLOW_KEY)) return
  if (!/^\/[^/]+\/[^/]+\/pull\/\d+\/changes$/.test(location.pathname)) return

  retry(() => {
    // GitHub currently calls this either "Review changes" or the split
    // "Submit review Review" control on Files changed.
    const reviewChanges = findButtonMatching(/^(Review changes|Submit review)/)
    if (!reviewChanges) return false
    reviewChanges.click()
    console.debug(`[Quick Approve v${SCRIPT_VERSION}] opened native review dialog`) 

    retry(() => {
      // Current GitHub.com uses a menu: choosing this item submits approval.
      const approveMenuItem = findButtonMatching(/^Approve changes(?:\s|$)/)
      if (approveMenuItem) {
        approveMenuItem.click()
        sessionStorage.removeItem(GITHUB_REVIEW_FLOW_KEY)
        console.debug(`[Quick Approve v${SCRIPT_VERSION}] chose native Approve changes`)
        return true
      }

      // Older GitHub UI presents a dialog with radios and a final submit.
      const approve = document.querySelector(
        'input[value="approve"], input[name="pull_request_review[event]"][value="approve"], [role="radio"][value="approve"]'
      )
      const approveButton = findButtonMatching(/^Approve(?:\s|$)/)
      if (!approve && !approveButton) return false
      ;(approveButton ?? document.querySelector(`label[for="${approve.id}"]`) ?? approve).click()

      const dialog = (approve ?? approveButton).closest('[role="dialog"]') ?? document
      const submit = [...dialog.querySelectorAll('button')].find((button) =>
        /^Submit review/.test(button.textContent.trim()) &&
        button !== reviewChanges && !button.disabled
      )
      if (!submit) return false
      submit.click()
      sessionStorage.removeItem(GITHUB_REVIEW_FLOW_KEY)
      console.debug(`[Quick Approve v${SCRIPT_VERSION}] submitted native GitHub review`)
      return true
    }, 40, () => reviewUiDebug('controls not found after 10 seconds'))
    return true
  }, 40, () => reviewUiDebug('Review changes button not found after 10 seconds'))
}

export const getApiBase = (location = window.location) => {
  const { hostname, origin } = location
  if (hostname === 'github.com') return 'https://api.github.com'
  return `${origin}/api/v3`
}

// Overridable in tests — avoids real navigation and setTimeout races
export let navigate = (url) => setTimeout(() => { window.location.href = url }, 800)
export const setNavigate = (fn) => { navigate = fn }

export const isPullRequestPage = (location = window.location) =>
  /^\/[^/]+\/[^/]+\/pull\/\d+/.test(location.pathname)

// header container selector: github.com (Primer React) + GHES (classic)
export const HEADER_ACTIONS_SELECTOR = '.gh-header-actions, [class*="PageHeader-Actions"]'

// Read the PR head commit from the rendered page. GHES keeps it in a hidden
// `head_sha` input; GitHub.com may embed it in JSON as `headRefOid`.
export const getHeadShaFromPage = () => {
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

export function waitForElement(selector, timeout = 5000) {
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

export const insertButton = () => {
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

  button.addEventListener('click', async (e) => {
    e.preventDefault()
    console.debug(`[Quick Approve v${SCRIPT_VERSION}] click`, { url: location.href })
    button.disabled = true
    button.innerText = 'Approving…'

    try {
      if (window.location.hostname === 'github.com') {
        beginGithubApproval({ owner, repo, prNumber })
        return
      }

      const origin = window.location.origin

      // GHES uses its legacy HTML /reviews endpoint. Prefer
      // current-page data; `/files` is only a legacy GHES fallback.
      const { token, headSha: formSha } = await getReviewFormData({ owner, repo, prNumber, origin })

      // Prefer legacy form head_sha; else page payload; else REST API.
      let head_sha = formSha || getHeadShaFromPage()
      if (!head_sha && window.location.hostname === 'github.com') {
        const apiBase = getApiBase()
        console.warn('[Quick Approve] falling back to REST API', {
          apiUrl: `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`,
        })

        const prRes = await fetch(
          `${apiBase}/repos/${owner}/${repo}/pulls/${prNumber}`,
          {
            headers: { Accept: 'application/vnd.github.v3+json' },
            // Content scripts execute under moz-extension:// / chrome-extension://.
            // Explicitly include the signed-in GitHub session for cross-origin API calls.
            credentials: 'include',
          }
        )
        if (!prRes.ok) {
          const response = await prRes.text()
          throw new Error(`API ${prRes.status}: ${prRes.statusText} ${response}`)
        }
        const pr = await prRes.json()
        head_sha = pr.head?.sha
      }
      if (!head_sha) throw new Error('head_sha not found')
      if (!token) throw new Error('could not obtain approval token from /files form')

      const body = new URLSearchParams({
        '_method': 'put',
        'pull_request_review[event]': 'approve',
        'head_sha': head_sha,
        'authenticity_token': token,
      })

      const res = await fetch(
        `${origin}/${owner}/${repo}/pull/${prNumber}/reviews`,
        {
          method: 'POST',
          // Must run under the current GitHub session, not the extension origin.
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        }
      )

      if (res.ok) {
        button.innerText = '✓ Approved'
        button.classList.remove('btn-primary')
        button.classList.add('btn-success')
        button.disabled = true
        navigate(`${origin}/${owner}/${repo}/pulls`)
      } else {
        const response = await res.text()
        const reason = response || res.statusText || 'No response body'
        console.error(`[Quick Approve v${SCRIPT_VERSION}] review rejected`, {
          status: res.status,
          statusText: res.statusText,
          response,
        })
        button.innerText = `✗ ${res.status}: ${reason}`
        throw new Error(`HTTP ${res.status}: ${reason}`)
      }
    } catch (err) {
      console.error('Quick Approve error:', err)
      if (!button.innerText.startsWith('✗')) button.innerText = '✗ Failed'
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
export const setupHotkey = () => {
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

export const observeUrlChange = () => {
  console.debug(`[Quick Approve v${SCRIPT_VERSION}] boot`, {
    url: location.href,
    headerActions: document.querySelectorAll(HEADER_ACTIONS_SELECTOR).length,
  })

  let oldHref = document.location.href
  const observer = new MutationObserver(() => {
    if (oldHref !== document.location.href) {
      oldHref = document.location.href
      insertButton()
      resumeGithubApproval()
      return
    }

    // A hot-reloaded extension can leave an old content-script listener on
    // its button. Replace that stale DOM node with this generation's button.
    const current = document.getElementById('quick-approve-btn')
    if (current && current.dataset.quickApproveVersion !== SCRIPT_VERSION) {
      console.debug(`[Quick Approve v${SCRIPT_VERSION}] replacing stale button`, {
        staleVersion: current.dataset.quickApproveVersion ?? 'unknown',
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
  resumeGithubApproval()
  setupHotkey()
}
