// ==UserScript==
// @name        Github Quick Approve
// @icon        https://raw.githubusercontent.com/monodyle/github-quick-approve/main/assets/icons/icon_256.png
// @namespace   https://github.com/monodyle
// @author      monodyle
// @license     MIT
// @version     1.0.0
// @description Quick Approve for Github PR
// @include     https://github.com/*/pull/*
// @homepageURL https://github.com/monodyle/github-quick-approve
// @supportURL  https://github.com/monodyle/github-quick-approve/issues
// @downloadURL https://raw.githubusercontent.com/monodyle/github-quick-approve/main/GithubQuickApprove.user.js
// @updateURL   https://raw.githubusercontent.com/monodyle/github-quick-approve/main/GithubQuickApprove.user.js
// ==/UserScript==

const insertButton = () => {
  const prevForm = document.getElementById("quick-approve-form");
  if (prevForm) prevForm.remove();

  const paths = window.location.pathname.split("/").slice(1, 5);
  console.log("Github Quick Approve", paths.at(-1));

  const form = document.createElement("form");
  form.setAttribute("id", "quick-approve-form");
  form.setAttribute("action", "/" + paths.join("/") + "/reviews");
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
  approveButton.innerText = "Quick Approve";
  approveButton.setAttribute("style", "margin-right: 4px");
  form.append(approveButton);
  var xhr = new XMLHttpRequest();
  xhr.onreadystatechange = function () {
    // console.debug('onreadystatechange')
    if (xhr.readyState === 4) {
      // console.debug('xhr.readyState')
      if (
        /name="pull_request_review\[event\]" value="approve" disabled/g.test(
          xhr.responseText
        )
      ) {
        console.debug("You do not have permission to approve this PR");
        return;
      }

      if (xhr.status !== 200) {
        console.debug("Error", xhr.status, xhr.statusText);
        return;
      }
      /* 
             /<form id="pull_requests_submit_review".*name="authenticity_token" value="([^"]+)".+\n\s+.+id="head_sha" value="([^"]+)".+\n.*\n.*\n.+value="([^"]+)" data-csrf="true"/g
            */

      const parser = new DOMParser();
      const responseXML = parser.parseFromString(xhr.responseText, "text/html");

      const reviewForm = responseXML.querySelector(
        "form#pull_requests_submit_review"
      );
      console.debug("xhr.responseXML", reviewForm);

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
        console.debug("Error: Could not find required input values");
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
  xhr.open("GET", "https://github.com/" + paths.join("/") + "/files");
  xhr.send();

  const headerActions = document.querySelector(".gh-header-actions");
  if (headerActions) {
    headerActions.append(form);
  }
};

let oldHref = document.location.href;
const documentMutationObserver = new MutationObserver((_) => {
  if (oldHref !== document.location.href) {
    oldHref = document.location.href;
    if (document.location.pathname.match(/\/pull\/\d+/)) {
      insertButton();
    }
  }
});

document.addEventListener("DOMContentLoaded", () => {
  documentMutationObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
  const path = window.location.pathname;
  if (path.match(/\/pull\/\d+/)) {
    insertButton();
  }
});
window.onload = documentMutationObserver;
