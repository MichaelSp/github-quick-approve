// ==UserScript==
// @name        Github Quick Approve
// @icon        https://raw.githubusercontent.com/monodyle/github-quick-approve/main/assets/icons/icon_256.png
// @namespace   https://github.com/monodyle
// @author      monodyle
// @license     MIT
// @version     2.0.0
// @description Quick Approve for Github PR
// @match       https://github.com/*
// @homepageURL https://github.com/monodyle/github-quick-approve
// @supportURL  https://github.com/monodyle/github-quick-approve/issues
// @downloadURL https://raw.githubusercontent.com/monodyle/github-quick-approve/main/GithubQuickApprove.user.js
// @updateURL   https://raw.githubusercontent.com/monodyle/github-quick-approve/main/GithubQuickApprove.user.js
// ==/UserScript==

function prIsOpenAndNotApproved() {
  const currentPRIsOpen = document.querySelector('span.State--open');
  const currentPRIsAlreadyApproved = document.querySelector(
    'input[name="pull_request_review[event]"][value="approve"]:checked'
  );
  const sidebarApproved = Array.from(
    document.querySelectorAll('.js-issue-sidebar-form tool-tip')
  ).some(el => el.textContent.includes('approved these changes'));

  return (!currentPRIsAlreadyApproved && !sidebarApproved && currentPRIsOpen)
}

function updateFormWithRemoteData(form, csrfInput, authenticityTokenInput, headShaInput) {
  const paths = window.location.pathname.split("/").slice(1, 5);
  form.setAttribute("action", "/" + paths.join("/") + "/reviews");

  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    if (xhr.readyState === /* DONE */ 4) {
      if (
        /name="pull_request_review\[event\]" value="approve" disabled/g.test(
          xhr.responseText
        )
      ) {
        console.debug("You do not have permission to approve this PR");
        return;
      }

      if (xhr.status !== 200) {
        console.error("Error", xhr.status, xhr.statusText);
        return;
      }

      const parser = new DOMParser();
      const responseXML = parser.parseFromString(xhr.responseText, "text/html");

      const reviewForm = responseXML.querySelector(
        "form#pull_requests_submit_review"
      );

      const csrfInputValue = reviewForm.querySelector(
        'input[data-csrf="true"]'
      ).value;
      const authenticityTokenInputValue = reviewForm.querySelector(
        'input[name="authenticity_token"]'
      ).value;
      const headShaInputValue = reviewForm.querySelector(
        'input[name="head_sha"]'
      ).value;

      if (
        !csrfInputValue ||
        !authenticityTokenInputValue ||
        !headShaInputValue
      ) {
        console.error("Error: Could not find required input values");
        return;
      }

      csrfInput.setAttribute("value", csrfInputValue);
      authenticityTokenInput.setAttribute("value", authenticityTokenInputValue);
      headShaInput.setAttribute("value", headShaInputValue);

      const headerActions =
        document.getElementsByClassName("gh-header-actions")[0];
      headerActions.append(form);
    }
  };
  xhr.open("GET", `${githubHost}/${paths.join("/")}/files`);
  xhr.send();
}

const insertButton = () => {
  const prevForm = document.getElementById("quick-approve-form");
  if (prevForm) prevForm.remove();

  if (!prIsOpenAndNotApproved()) {
    console.warn("not open OR already approved")
    return;
  }


  const form = document.createElement("form");
  form.setAttribute("id", "quick-approve-form");
  form.setAttribute("accept-charset", "UTF-8");
  form.setAttribute("method", "post");

  const methodInput = document.createElement("input");
  methodInput.setAttribute("type", "hidden");
  methodInput.setAttribute("name", "_method");
  methodInput.setAttribute("value", "put");
  form.append(methodInput);

  const authenticityTokenInput = document.createElement("input");
  authenticityTokenInput.setAttribute("type", "hidden");
  authenticityTokenInput.setAttribute("name", "authenticity_token");
  form.append(authenticityTokenInput);

  const headShaInput = document.createElement("input");
  headShaInput.setAttribute("type", "hidden");
  headShaInput.setAttribute("name", "head_sha");
  headShaInput.setAttribute("id", "head_sha");
  form.append(headShaInput);

  const csrfInput = document.createElement("input");
  csrfInput.setAttribute("type", "hidden");
  csrfInput.setAttribute("data-csrf", "true");
  form.append(csrfInput);

  const approveRadio = document.createElement("input");
  approveRadio.setAttribute("type", "radio");
  approveRadio.setAttribute("name", "pull_request_review[event]");
  approveRadio.setAttribute("value", "approve");
  approveRadio.setAttribute("checked", "true");
  approveRadio.setAttribute(
    "style",
    "visibility: hidden;position: absolute;width: 0;height: 0;overflow: hidden;"
  );
  form.append(approveRadio);


  const approveButton = document.createElement("button");
  approveButton.setAttribute("type", "submit");
  approveButton.classList.add("btn");
  approveButton.classList.add("btn-sm");
  approveButton.classList.add("btn-primary");

  approveButton.innerText = "Quick Approve ✅";
  approveButton.setAttribute("style", "margin-right: 4px");
  form.append(approveButton);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = new FormData(form);
    fetch(githubHost + form.getAttribute("action"), { method: "POST", body: data })
      .then(() => {
        const parts = window.location.pathname.split("/").slice(1, 3);
        window.location.href = `/${parts.join("/")}/pulls`;
      });
  });

  updateFormWithRemoteData(form, csrfInput, authenticityTokenInput, headShaInput);
};

let oldHref = document.location.pathname;
const githubHost = window.location.origin;

const isPullRequestPage = () => /^\/[^/]+\/[^/]+\/pull\/\d+/.test(window.location.pathname);

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout waiting for ${selector}`)); }, timeout);
  });
}

function checkAndInsert() {
  if (!isPullRequestPage()) return;
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", insertButton, { once: true });
  } else {
    waitForElement(".gh-header-actions").then(insertButton).catch(() => {});
  }
}

const observeUrlChange = () => {
  const observer = new MutationObserver(() => {
    if (window.location.pathname !== oldHref) {
      oldHref = window.location.pathname;
      checkAndInsert();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  checkAndInsert();
};

observeUrlChange();

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "a" && !e.shiftKey && !e.altKey && !e.metaKey) {
    const form = document.getElementById("quick-approve-form");
    if (form) {
      e.preventDefault();
      form.submit();
    }
  }
});
