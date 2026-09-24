import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getFetchNonce,
  getReviewFormData,
  getApiBase,
  getHeadShaFromPage,
  isPullRequestPage,
  HEADER_ACTIONS_SELECTOR,
  waitForElement,
  insertButton,
  setupHotkey,
  setNavigate,
  beginGithubApproval,
  resumeGithubApproval,
} from './core.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Set window.location to a fake URL (jsdom doesn't allow direct assignment) */
function setLocation(url) {
  const u = new URL(url)
  Object.defineProperty(window, 'location', {
    value: {
      href: u.href,
      origin: u.origin,
      hostname: u.hostname,
      pathname: u.pathname,
      assign: vi.fn(),
    },
    writable: true,
    configurable: true,
  })
}

/** Build a minimal github.com PR page DOM */
function buildGithubComDOM({ headerClass = 'prc-PageHeader-Actions-abc123' } = {}) {
  document.body.innerHTML = `
    <meta name="fetch-nonce" content="v2:test-nonce-ghcom">
    <meta name="csrf-token" content="page-csrf-tok-ghcom">
    <div class="${headerClass}">
      <button>Code</button>
    </div>
    <span class="prc-StateLabel-StateLabel-xyz Open">Open</span>
  `
}

/** Build a minimal GHES PR page DOM */
function buildGhesDOM() {
  document.body.innerHTML = `
    <meta name="fetch-nonce" content="v2:test-nonce-ghes">
    <input type="hidden" name="head_sha" value="cafebabe1234567890cafebabe1234567890cafe">
    <div class="gh-header-actions mt-0 mb-3">
      <button class="Button--secondary Button--small Button">Edit</button>
    </div>
    <span class="State State--open">Open</span>
  `
}

/** Mock fetch: /files review form + reviews endpoint */
function mockFetch({ headSha = 'abc123def456', reviewsOk = true, token = 'csrf-tok-xyz', canApprove = true } = {}) {
  return vi.fn(async (url) => {
    if (url.includes('/files')) {
      const disabledAttr = canApprove ? '' : ' disabled'
      return {
        ok: true,
        status: 200,
        text: async () => `
          <form id="pull_requests_submit_review">
            <input type="hidden" name="authenticity_token" value="${token}">
            <input type="hidden" name="head_sha" value="${headSha}">
            <input type="radio" name="pull_request_review[event]" value="approve"${disabledAttr}>
          </form>
        `,
      }
    }
    if (url.includes('/pulls/')) {
      return { ok: true, json: async () => ({ head: { sha: headSha } }) }
    }
    if (url.includes('/reviews')) {
      return {
        ok: reviewsOk,
        status: reviewsOk ? 200 : 422,
        statusText: reviewsOk ? 'OK' : 'Unprocessable Entity',
        text: async () => reviewsOk ? '' : 'review rejected',
      }
    }
    return { ok: false, status: 404 }
  })
}

/** Fire a keyboard event on document */
function fireKey(key, modifiers = {}) {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key,
    ctrlKey: modifiers.ctrlKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    bubbles: true,
  }))
}

// ─── getApiBase ───────────────────────────────────────────────────────────────

describe('getApiBase', () => {
  it('returns api.github.com for github.com', () => {
    expect(getApiBase({ hostname: 'github.com', origin: 'https://github.com' }))
      .toBe('https://api.github.com')
  })

  it('returns /api/v3 for GHES', () => {
    expect(getApiBase({ hostname: 'github.tools.sap', origin: 'https://github.tools.sap' }))
      .toBe('https://github.tools.sap/api/v3')
  })

  it('returns /api/v3 for any other GHES hostname', () => {
    expect(getApiBase({ hostname: 'github.example.corp', origin: 'https://github.example.corp' }))
      .toBe('https://github.example.corp/api/v3')
  })
})

// ─── isPullRequestPage ────────────────────────────────────────────────────────

describe('isPullRequestPage', () => {
  it('matches a standard PR URL', () => {
    expect(isPullRequestPage({ pathname: '/owner/repo/pull/42' })).toBe(true)
  })

  it('also matches a PR with extra path segments (tabs like /files)', () => {
    expect(isPullRequestPage({ pathname: '/owner/repo/pull/42/files' })).toBe(true)
  })

  it('rejects repo root', () => {
    expect(isPullRequestPage({ pathname: '/owner/repo' })).toBe(false)
  })

  it('rejects PR list page', () => {
    expect(isPullRequestPage({ pathname: '/owner/repo/pulls' })).toBe(false)
  })

  it('handles dot in repo name (GHES style like .workflows)', () => {
    expect(isPullRequestPage({ pathname: '/cloud-orchestration/.workflows/pull/128' })).toBe(true)
  })
})

// ─── getHeadShaFromPage ──────────────────────────────────────────────────────

describe('getHeadShaFromPage', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('extracts head_sha from GHES hidden input', () => {
    document.body.innerHTML = `
      <input type="hidden" name="head_sha" value="984d6358cbd642f71abb50bbb768cd46335627de">
    `
    expect(getHeadShaFromPage()).toBe('984d6358cbd642f71abb50bbb768cd46335627de')
  })

  it('extracts head_sha (snake_case) from inline script JSON', () => {
    document.body.innerHTML = `
      <script type="application/json">{"payload":{"head_sha":"deadbeef1234567890deadbeef1234567890dead"}}</script>
    `
    expect(getHeadShaFromPage()).toBe('deadbeef1234567890deadbeef1234567890dead')
  })

  it('extracts headSha (camelCase variant)', () => {
    document.body.innerHTML = `
      <script type="application/json">{"headSha":"cafebabe1234567890cafebabe1234567890cafe"}</script>
    `
    expect(getHeadShaFromPage()).toBe('cafebabe1234567890cafebabe1234567890cafe')
  })

  it('extracts headRefOid from modern GitHub page data', () => {
    document.body.innerHTML = `
      <script type="application/json">{"headRefOid":"0123456789abcdef0123456789abcdef01234567"}</script>
    `
    expect(getHeadShaFromPage()).toBe('0123456789abcdef0123456789abcdef01234567')
  })

  it('returns null when no sha in any script', () => {
    document.body.innerHTML = '<script type="application/json">{"foo":"bar"}</script>'
    expect(getHeadShaFromPage()).toBeNull()
  })

  it('returns null when no script tags at all', () => {
    document.body.innerHTML = ''
    expect(getHeadShaFromPage()).toBeNull()
  })
})

// ─── getFetchNonce ────────────────────────────────────────────────────────────

describe('getFetchNonce', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('reads nonce from meta tag', () => {
    document.head.innerHTML = '<meta name="fetch-nonce" content="v2:abc">'
    expect(getFetchNonce()).toBe('v2:abc')
  })

  it('returns null when meta is absent', () => {
    document.head.innerHTML = ''
    expect(getFetchNonce()).toBeNull()
  })
})

// ─── waitForElement ───────────────────────────────────────────────────────────

describe('waitForElement', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('resolves immediately when element already exists', async () => {
    document.body.innerHTML = '<div class="gh-header-actions"></div>'
    const el = await waitForElement('.gh-header-actions')
    expect(el).toBeTruthy()
  })

  it('resolves after element is dynamically added', async () => {
    document.body.innerHTML = ''
    const promise = waitForElement('.gh-header-actions', 1000)
    setTimeout(() => {
      const div = document.createElement('div')
      div.className = 'gh-header-actions'
      document.body.appendChild(div)
    }, 50)
    const el = await promise
    expect(el).toBeTruthy()
  })

  it('rejects on timeout when element never appears', async () => {
    document.body.innerHTML = ''
    await expect(waitForElement('.never-exists', 50)).rejects.toThrow('Timeout')
  })
})

// ─── HEADER_ACTIONS_SELECTOR ──────────────────────────────────────────────────

describe('HEADER_ACTIONS_SELECTOR', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('matches GHES .gh-header-actions', () => {
    document.body.innerHTML = '<div class="gh-header-actions"></div>'
    expect(document.querySelector(HEADER_ACTIONS_SELECTOR)).toBeTruthy()
  })

  it('matches github.com Primer React PageHeader-Actions (hashed class)', () => {
    document.body.innerHTML = '<div class="prc-PageHeader-Actions-abc123 flex-items-center"></div>'
    expect(document.querySelector(HEADER_ACTIONS_SELECTOR)).toBeTruthy()
  })

  it('does not match unrelated elements', () => {
    document.body.innerHTML = '<div class="some-other-class"></div>'
    expect(document.querySelector(HEADER_ACTIONS_SELECTOR)).toBeNull()
  })
})

// ─── insertButton — github.com layout ────────────────────────────────────────

describe('insertButton on github.com', () => {
  beforeEach(() => {
    setLocation('https://github.com/myorg/myrepo/pull/99')
    buildGithubComDOM()
    global.fetch = mockFetch()
  })
  afterEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('injects the button into the header actions container', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    const container = document.querySelector(HEADER_ACTIONS_SELECTOR)
    expect(container.contains(document.getElementById('quick-approve-btn'))).toBe(true)
  })

  it('button text is "Quick Approve ✅"', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    expect(document.getElementById('quick-approve-btn').innerText).toBe('Quick Approve ✅')
  })

  it('removes a previous button before inserting a new one', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    insertButton()
    await vi.waitFor(() => {
      const btns = document.querySelectorAll('#quick-approve-btn')
      expect(btns.length).toBe(1)
    })
  })

  it('does not insert on non-PR pages', () => {
    setLocation('https://github.com/myorg/myrepo/pulls')
    insertButton()
    expect(document.getElementById('quick-approve-btn')).toBeNull()
  })
})

// ─── insertButton — GHES layout ───────────────────────────────────────────────

describe('insertButton on GHES', () => {
  beforeEach(() => {
    setLocation('https://github.tools.sap/cloud-orchestration/.workflows/pull/128')
    buildGhesDOM()
    global.fetch = mockFetch()
  })
  afterEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('injects button into .gh-header-actions', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    const container = document.querySelector('.gh-header-actions')
    expect(container.contains(document.getElementById('quick-approve-btn'))).toBe(true)
  })
})

// ─── approve flow — github.com ────────────────────────────────────────────────

describe('GitHub native review flow', () => {
  beforeEach(() => sessionStorage.clear())
  afterEach(() => sessionStorage.clear())

  it('uses the scoped review-form token instead of the generic page token', async () => {
    document.head.innerHTML = '<meta name="csrf-token" content="generic-token">'
    const fetch = mockFetch({
      token: 'review-token',
      headSha: 'cafebabe1234567890cafebabe1234567890cafe',
    })
    global.fetch = fetch
    await expect(getReviewFormData({ owner: 'myorg', repo: 'myrepo', prNumber: '99', origin: 'https://github.tools.sap' }))
      .resolves.toEqual({ token: 'review-token', headSha: 'cafebabe1234567890cafebabe1234567890cafe' })
    expect(fetch).toHaveBeenCalledWith(
      'https://github.tools.sap/myorg/myrepo/pull/99/files',
      { credentials: 'include' }
    )
  })

  it('navigates to Files changed and records a pending approval', () => {
    setLocation('https://github.com/myorg/myrepo/pull/99')
    beginGithubApproval({ owner: 'myorg', repo: 'myrepo', prNumber: '99' })
    expect(sessionStorage.getItem('quickApproveGithubReviewPending')).toBe('true')
    expect(window.location.assign).toHaveBeenCalledWith('/myorg/myrepo/pull/99/changes')
  })

  for (const [entrypoint, controls] of [
    ['Review changes', '<input type="radio" value="approve"><button>Submit review</button>'],
    ['Submit reviewReview', '<button>Approve changes</button>'],
  ]) {
    it(`opens and submits approval from ${entrypoint}`, async () => {
      setLocation('https://github.com/myorg/myrepo/pull/99/changes')
      sessionStorage.setItem('quickApproveGithubReviewPending', 'true')
      document.body.innerHTML = `<button>${entrypoint}</button>${controls}`
      resumeGithubApproval()
      await vi.waitFor(() => expect(sessionStorage.getItem('quickApproveGithubReviewPending')).toBeNull())
    })
  }
})

// ─── approve flow — GHES ──────────────────────────────────────────────────────

describe('approve flow on GHES', () => {
  const HEAD_SHA = 'cafebabe1234567890cafebabe1234567890cafe'

  beforeEach(() => {
    setLocation('https://github.tools.sap/cloud-orchestration/.workflows/pull/128')
    buildGhesDOM()
    global.fetch = mockFetch({ headSha: HEAD_SHA })
  })
  afterEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('uses GHES page head_sha without calling the unauthenticated REST API', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    document.getElementById('quick-approve-btn').click()
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/v3/repos/'), expect.anything()
    )
  })

  it('POSTs review to GHES origin with session credentials', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    document.getElementById('quick-approve-btn').click()
    await vi.waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      'https://github.tools.sap/cloud-orchestration/.workflows/pull/128/reviews',
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    ))
  })

  it('sends head_sha in the review body', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    document.getElementById('quick-approve-btn').click()
    await vi.waitFor(() => {
      const reviewCall = global.fetch.mock.calls.find(([url]) => url.includes('/reviews'))
      expect(reviewCall).toBeTruthy()
      expect(reviewCall[1].body).toContain(HEAD_SHA)
    })
  })

  it('shows ✓ Approved on success', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    document.getElementById('quick-approve-btn').click()
    await vi.waitFor(() =>
      expect(document.getElementById('quick-approve-btn').innerText).toBe('✓ Approved')
    )
  })

  it('nonce header is no longer sent (form token is used instead)', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    document.getElementById('quick-approve-btn').click()
    await vi.waitFor(() => {
      const reviewCall = global.fetch.mock.calls.find(([url]) => url.includes('/reviews'))
      expect(reviewCall[1].headers['X-Fetch-Nonce']).toBeUndefined()
      expect(reviewCall[1].body).toContain('authenticity_token=csrf-tok-xyz')
    })
  })

  it('shows a clear error and does NOT POST when approval is not permitted', async () => {
    global.fetch = mockFetch({ headSha: HEAD_SHA, canApprove: false })
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    document.getElementById('quick-approve-btn').click()
    await vi.waitFor(() =>
      expect(document.getElementById('quick-approve-btn').innerText).toBe('✗ Failed')
    )
    const reviewCall = global.fetch.mock.calls.find(([url]) => url.includes('/reviews'))
    expect(reviewCall).toBeUndefined()
    expect(document.getElementById('quick-approve-btn').disabled).toBe(false)
  })
})

// ─── navigate to /pulls after approve ────────────────────────────────────────

describe('navigate to /pulls after approve', () => {
  let navSpy

  beforeEach(() => {
    setLocation('https://github.tools.sap/myorg/myrepo/pull/99')
    buildGhesDOM()
    global.fetch = mockFetch()
    // Replace the navigate function with a synchronous spy — no timers needed
    navSpy = vi.fn()
    setNavigate(navSpy)
  })
  afterEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
    vi.restoreAllMocks()
    // Restore default navigate
    setNavigate((url) => setTimeout(() => { window.location.href = url }, 800))
  })

  it('navigates to /pulls after successful approve (github.com)', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    document.getElementById('quick-approve-btn').click()
    await vi.waitFor(() =>
      expect(document.getElementById('quick-approve-btn').innerText).toBe('✓ Approved')
    )
    expect(navSpy).toHaveBeenCalledWith('https://github.tools.sap/myorg/myrepo/pulls')
  })

  it('does not navigate on failed approve', async () => {
    global.fetch = mockFetch({ reviewsOk: false })
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    document.getElementById('quick-approve-btn').click()
    await vi.waitFor(() =>
      expect(document.getElementById('quick-approve-btn').innerText).toBe('✗ 422: review rejected')
    )
    expect(navSpy).not.toHaveBeenCalled()
  })
})

// ─── Ctrl+A hotkey ────────────────────────────────────────────────────────────

describe('Ctrl+A hotkey', () => {
  beforeEach(() => {
    setLocation('https://github.com/myorg/myrepo/pull/99')
    buildGithubComDOM()
    global.fetch = mockFetch()
    setupHotkey()
  })
  afterEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
    delete document.documentElement.dataset.quickApproveHotkeySetup
    vi.restoreAllMocks()
  })

  it('Ctrl+A clicks the approve button when it exists', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    const btn = document.getElementById('quick-approve-btn')
    const clickSpy = vi.spyOn(btn, 'click')
    fireKey('a', { ctrlKey: true })
    expect(clickSpy).toHaveBeenCalledOnce()
  })

  it('Ctrl+A does nothing when button is absent', () => {
    // No insertButton() call — button not in DOM
    expect(() => fireKey('a', { ctrlKey: true })).not.toThrow()
  })

  it('Ctrl+A does nothing when button is disabled (already approving)', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    const btn = document.getElementById('quick-approve-btn')
    btn.disabled = true
    const clickSpy = vi.spyOn(btn, 'click')
    fireKey('a', { ctrlKey: true })
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('plain "a" keypress does not trigger approve', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    const btn = document.getElementById('quick-approve-btn')
    const clickSpy = vi.spyOn(btn, 'click')
    fireKey('a')  // no Ctrl
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('Ctrl+Shift+A does not trigger approve', async () => {
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    const btn = document.getElementById('quick-approve-btn')
    const clickSpy = vi.spyOn(btn, 'click')
    fireKey('a', { ctrlKey: true, shiftKey: true })
    expect(clickSpy).not.toHaveBeenCalled()
  })

  it('Ctrl+A on GHES also triggers approve', async () => {
    setLocation('https://github.tools.sap/cloud-orchestration/.workflows/pull/128')
    buildGhesDOM()
    insertButton()
    await vi.waitFor(() => expect(document.getElementById('quick-approve-btn')).toBeTruthy())
    const btn = document.getElementById('quick-approve-btn')
    const clickSpy = vi.spyOn(btn, 'click')
    fireKey('a', { ctrlKey: true })
    expect(clickSpy).toHaveBeenCalledOnce()
  })
})
