/**
 * Webview side of the panel project selector (see panelProject.ts). Plain strings, no vscode
 * import, so every inline-HTML panel can embed it:
 *
 *   <style>${PROJECT_SELECTOR_CSS}</style>        (once, in <head>)
 *   ${projectSelectorMarkup()}                    (in the header / toolbar)
 *   <script nonce="...">${projectSelectorScript("vscode")}</script>
 *
 * `apiExpr` is the JS expression that evaluates to the panel's acquireVsCodeApi() object
 * (evaluated lazily, when the user picks). The selector stays hidden until the host reports
 * `visible` (more than one project).
 */

export const PROJECT_SELECTOR_CSS = `
.asfx-project { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; font-size: 12px; font-weight: normal; text-transform: none; letter-spacing: normal; }
.asfx-project[hidden] { display: none; }
.asfx-project label { color: var(--vscode-descriptionForeground); }
.asfx-project select {
  background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
  border-radius: 2px; padding: 2px 4px; font-family: inherit; font-size: inherit; max-width: 260px;
}
.asfx-project select:focus { outline: 1px solid var(--vscode-focusBorder); }
`;

export function projectSelectorMarkup(): string {
	return `<span class="asfx-project" id="asfxProject" hidden><label for="asfxProjectSel">Project</label><select id="asfxProjectSel" title="Project this panel works on"></select></span>`;
}

export function projectSelectorScript(apiExpr: string): string {
	return `(function () {
  var wrap = document.getElementById('asfxProject');
  var sel = document.getElementById('asfxProjectSel');
  if (!wrap || !sel) return;
  function post(msg) { try { var api = ${apiExpr}; if (api) api.postMessage(msg); } catch (e) {} }
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.type !== 'projectOptions') return;
    wrap.hidden = !m.visible;
    sel.innerHTML = '';
    (m.options || []).forEach(function (o) {
      var opt = document.createElement('option');
      opt.value = o.dir;
      opt.textContent = o.name + (o.defaultOrgLabel ? ' (' + o.defaultOrgLabel + ')' : '') + (o.active ? ' \\u2022' : '');
      opt.title = o.dir;
      if (o.dir === m.current) opt.selected = true;
      sel.appendChild(opt);
    });
  });
  sel.addEventListener('change', function () { post({ type: 'selectProject', dir: sel.value }); });
  // After every script of the page ran, so the panel's api variable exists whatever the script order.
  setTimeout(function () { post({ type: 'asfxProjectReady' }); }, 0);
})();`;
}
